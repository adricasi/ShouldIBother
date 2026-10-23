import { execFile, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { EVALS_DIR, EVAL_JOBS } from "../../src/eval/cases.js";
import { EVAL_JOB_SPECS } from "../../src/eval/jobs.js";
import type { EvalReport } from "../../src/eval/report.js";
import { writeCandidateFixtures } from "../../src/eval/record-fixtures.js";
import { FIXTURES_DIR, FakeModelClient } from "../../src/server/model/fake.js";

import { PLANTED_METADATA, syntheticPhoto } from "../support/photos.js";

import { EchoModel, depsFor, runEvalCli, stagedPhotos, tempDir } from "./support.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readReport(out: string): EvalReport {
  return JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as EvalReport;
}

/** The staged photos a case set names, as the builder would put them in the folder. */
async function photosFor(job: (typeof EVAL_JOBS)[number], path?: string): Promise<string> {
  const cases = EVAL_JOB_SPECS[job].prepare(path ?? join(EVALS_DIR, job, "cases.json"));
  return stagedPhotos(cases.flatMap((entry) => entry.photos.map((photo) => photo.name)));
}

describe("T-010: sib eval on a model that answers correctly (exit 0)", () => {
  it.each(["listener", "bookmaker", "safety", "laundry-planner", "judge"] as const)(
    "%s: all 20 committed cases are valid, the report is written and the exit code is 0",
    async (job) => {
      const model = new EchoModel();
      const out = join(tempDir(), "out");
      const { code, output } = await runEvalCli([job, "--out", out], depsFor(model));
      expect(code).toBe(0);
      expect(output).toContain("TARGET MET");
      const report = readReport(out);
      expect(report).toMatchObject({
        job,
        mode: "ollama",
        model: "echo-gemma",
        modelDigest: "sha256:echo",
        date: "2026-10-23 14:00:00 Europe/Madrid",
        health: { state: "online" },
      });
      expect(report.cases).toHaveLength(20);
      expect(report.summary).toMatchObject({ cases: 20, primaryValid: 20, targetMet: true });
      expect(report.promptVersions.length).toBeGreaterThan(0);
      expect(report.promptVersions.every((version) => /\.v\d+$/.test(version))).toBe(true);
      expect(report.runner).toEqual({
        toolUse: "native",
        answerMode: "single_call",
        callTimeoutMs: 30_000,
        deadlineMs: 45_000,
      });
      expect(readFileSync(join(out, "report.md"), "utf8")).toContain(`# sib eval ${job}`);
    },
  );

  it("REQ-003: the bookmaker eval calls get_forecast in every case, in two model calls", async () => {
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(
      ["bookmaker", "--out", out],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(0);
    const report = readReport(out);
    expect(report.summary.toolUse).toEqual({
      bookmakerRuns: 20,
      called: 20,
      injected: 0,
      missed: 0,
      firstAnswerWithTool: 20,
    });
    expect(report.cases.every((entry) => entry.toolMode === "called" && entry.calls === 2)).toBe(
      true,
    );
    expect(output).toContain("Tool calls (bookmaker): called 20");
    expect(output).toContain("Latency (job time with retries): p50");
  });

  it("NFR-004: the inspector eval runs the bookmaker with what the inspector saw and reports photo time", async () => {
    const model = new EchoModel();
    const out = join(tempDir(), "out");
    const photos = await photosFor("inspector");
    const { code, output } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", out],
      depsFor(model),
    );
    expect(code).toBe(0);
    const report = readReport(out);
    expect(report.summary.withinPhotoBudget).toBe(20);
    expect(report.summary.criteria.map((entry) => entry.id)).toEqual([
      "valid_json",
      "photo_judgement_15s",
    ]);
    expect(
      report.cases.every((entry) => entry.steps.map((s) => s.job).join() === "inspector,bookmaker"),
    ).toBe(true);
    expect(report.promptVersions).toEqual(["inspector.v1", "bookmaker.v1"]);
    expect(output).toContain("Photo flow valid within 15 s");
    // The bookmaker saw the inspector's observations, and the photo went to the inspector only.
    const bookmakerCalls = model.requests.filter((request) => request.job === "bookmaker");
    expect(bookmakerCalls.length).toBe(40);
    expect(bookmakerCalls[0]?.messages[1]?.content).toContain("photo_observations");
    const inspectorCalls = model.requests.filter((request) => request.job === "inspector");
    expect(inspectorCalls.every((request) => request.images?.length === 1)).toBe(true);
    expect(bookmakerCalls.every((request) => request.images === undefined)).toBe(true);
  });

  it("T-030: the judge photo set sends the before and after photos as the live judge does", async () => {
    const model = new EchoModel();
    const out = join(tempDir(), "out");
    const path = join(EVALS_DIR, "judge", "photo-cases.json");
    const photos = await photosFor("judge", path);
    const { code } = await runEvalCli(
      ["judge", "--cases", path, "--photos", photos, "--out", out],
      depsFor(model),
    );
    expect(code).toBe(0);
    const counts = model.requests.map((request) => request.images?.length ?? 0);
    expect(counts.filter((count) => count === 2).length).toBeGreaterThan(10);
    expect(counts.filter((count) => count === 1).length).toBeGreaterThan(2);
    expect(readReport(out).cases).toHaveLength(20);
  });

  it("the eval does not write to the household database", async () => {
    const deps = depsFor(new EchoModel());
    const out = join(tempDir(), "out");
    await runEvalCli(["listener", "--out", out], deps);
    expect(readdirSync(deps.env?.["SIB_DATA_DIR"] ?? "")).toEqual([]);
  });
});

describe("NFR-004: sib eval misses the target (exit 3)", () => {
  const brokenFor =
    (words: readonly string[]) => (_request: unknown, data: Record<string, unknown>) =>
      words.some((word) => String(data["text"]).includes(word)) ? "{broken" : undefined;

  it("injected invalid answers: 18 of 20 valid exits 3, 19 of 20 exits 0", async () => {
    const two = new EchoModel();
    two.tamper = brokenFor(["pirate", "bill"]);
    const missedOut = join(tempDir(), "out");
    const missed = await runEvalCli(["listener", "--out", missedOut], depsFor(two));
    expect(missed.code).toBe(3);
    expect(missed.output).toContain("TARGET MISSED");
    expect(missed.output).toContain("FAIL  Valid JSON (listener): 18/20 (needs 19/20)");
    const report = readReport(missedOut);
    expect(report.summary).toMatchObject({
      primaryValid: 18,
      targetMet: false,
      failures: { invalid: 2 },
    });
    expect(
      report.cases
        .filter((entry) => !entry.valid)
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["bill", "injection"]);
    expect(readFileSync(join(missedOut, "report.md"), "utf8")).toContain("## Invalid cases");

    const one = new EchoModel();
    one.tamper = brokenFor(["pirate"]);
    const metOut = join(tempDir(), "out");
    const met = await runEvalCli(["listener", "--out", metOut], depsFor(one));
    expect(met.code).toBe(0);
    expect(readReport(metOut).summary).toMatchObject({ primaryValid: 19, targetMet: true });
  });

  it("an invalid answer is retried once with the error, and a good retry counts as valid", async () => {
    const model = new EchoModel();
    let broke = false;
    model.tamper = (_request, data) => {
      if (!broke && String(data["text"]).includes("pirate")) {
        broke = true;
        return "{broken";
      }
      return undefined;
    };
    const out = join(tempDir(), "out");
    const { code } = await runEvalCli(["listener", "--out", out], depsFor(model));
    expect(code).toBe(0);
    const retried = readReport(out).cases.find((entry) => entry.id === "injection");
    expect(retried).toMatchObject({ valid: true, retries: 1, calls: 2 });
    expect(readReport(out).summary.validFirstTry).toBe(19);
  });

  it("a model that never calls get_forecast fails the bookmaker target with tool_missed", async () => {
    const model = new EchoModel();
    const original = model.chat.bind(model);
    model.chat = async (request) => {
      const response = await original({
        job: request.job,
        messages: request.messages,
        timeoutMs: request.timeoutMs,
      });
      return response;
    };
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(["bookmaker", "--out", out], depsFor(model));
    expect(code).toBe(3);
    expect(output).toContain("FAIL  get_forecast used: 0/20");
    expect(readReport(out).summary.failures).toEqual({ tool_missed: 20 });
  });

  it("timeouts are misses, not an outage: the run goes on and exits 3", async () => {
    const model = new EchoModel();
    model.tamper = (_request, data) =>
      ["wash the car", "pay the electricity bill", "heater on or off tonight"].includes(
        String(data["text"]),
      )
        ? "timeout"
        : undefined;
    const out = join(tempDir(), "out");
    const { code } = await runEvalCli(["listener", "--out", out], depsFor(model));
    expect(code).toBe(3);
    expect(readReport(out).summary.failures).toEqual({ timeout: 3 });
  });

  it("the time of a case is the job time, so a slow model shows in the table (the 15 s maths are in summary.test.ts)", async () => {
    const model = new EchoModel();
    model.delayMs = 5;
    const out = join(tempDir(), "out");
    const photos = await photosFor("inspector");
    const { code } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", out],
      depsFor(model),
    );
    expect(code).toBe(0);
    expect(readReport(out).cases.every((entry) => entry.latencyMs >= 10)).toBe(true);
  });
});

describe("NFR-007: sib eval when Gemma is not there (exit 2)", () => {
  it("offline before the run: exit 2, the model is never asked, nothing is written", async () => {
    const model = new EchoModel();
    model.setHealth("offline");
    const deps = depsFor(model);
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(["listener", "--out", out], deps);
    expect(code).toBe(2);
    expect(output).toContain("Gemma is unreachable");
    expect(model.requests).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  it("stops answering in the middle: exit 2 and no report of a half run", async () => {
    const model = new EchoModel();
    model.tamper = (_request, data) =>
      String(data["text"]).includes("heater on or off") ? "unavailable" : undefined;
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(["listener", "--out", out], depsFor(model));
    expect(code).toBe(2);
    expect(output).toContain("Gemma stopped answering at case heater-off");
    expect(existsSync(out)).toBe(false);
  });

  it("the real Ollama client with nothing on 127.0.0.1 is unreachable too", async () => {
    const configDir = tempDir();
    copyFileSync(join(ROOT, "config", "rules.json"), join(configDir, "rules.json"));
    writeFileSync(
      join(configDir, "models.json"),
      JSON.stringify({ models: { e4b: { tag: "gemma4:e4b" } } }),
    );
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(["listener", "--out", out], {
      env: { SIB_DATA_DIR: tempDir() },
      configDir,
      fetch: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:11434")),
    });
    expect(code).toBe(2);
    expect(output).toContain("Ollama is not answering");
  });

  it("with no model tag configured and no fake, it says what to set (exit 1)", async () => {
    const configDir = tempDir();
    copyFileSync(join(ROOT, "config", "rules.json"), join(configDir, "rules.json"));
    const { code, output } = await runEvalCli(["listener", "--out", join(tempDir(), "out")], {
      env: { SIB_DATA_DIR: tempDir() },
      configDir,
    });
    expect(code).toBe(1);
    expect(output).toContain("config/models.json has no models.e4b.tag");
  });
});

describe("NFR-010: sib eval on the fake model says so", () => {
  it("SIB_FAKE_MODEL=1 runs the pipeline on fixtures and puts the warning in both reports", async () => {
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(["listener", "--out", out], {
      env: { SIB_FAKE_MODEL: "1", SIB_DATA_DIR: tempDir() },
    });
    expect(code).toBe(0);
    expect(output).toContain("FAKE MODEL");
    const report = readReport(out);
    expect(report).toMatchObject({ mode: "fake", model: "fake-gemma" });
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("NOT from Gemma");
  });

  it("the stock fake judge reads each tap like the app's fake does", async () => {
    const out = join(tempDir(), "out");
    const { code } = await runEvalCli(["judge", "--out", out], {
      env: { SIB_FAKE_MODEL: "1", SIB_DATA_DIR: tempDir() },
    });
    expect(code).toBe(0);
    const cases = readReport(out).cases;
    expect(cases.find((entry) => entry.id === "plants-wilting")?.answerKey).toBe("harmful_loss");
    expect(cases.find((entry) => entry.id === "do-it-would-not")?.answerKey).toBe(
      "weather_would_not",
    );
  });

  it("refuses --record-fixtures on the fake: fixtures must not come from fixtures", async () => {
    const record = join(tempDir(), "fixtures");
    const { code, output } = await runEvalCli(
      ["listener", "--out", join(tempDir(), "out"), "--record-fixtures", record],
      {
        env: { SIB_FAKE_MODEL: "1", SIB_DATA_DIR: tempDir() },
      },
    );
    expect(code).toBe(1);
    expect(output).toContain("needs the real model");
    expect(existsSync(record)).toBe(false);
  });
});

describe("NFR-002: where sib eval writes (the output guard)", () => {
  it("refuses --out inside the repository when git does not ignore it, before asking the model", async () => {
    const model = new EchoModel();
    const out = join(ROOT, "eval-report-should-not-exist");
    const { code, output } = await runEvalCli(["listener", "--out", out], depsFor(model));
    expect(code).toBe(1);
    expect(output).toContain("could be committed");
    expect(model.requests).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  it("accepts --out in a git-ignored folder of the repository", async () => {
    const out = join(ROOT, "backtest-runs", `eval-test-${String(process.pid)}`);
    try {
      const { code } = await runEvalCli(["listener", "--out", out], depsFor(new EchoModel()));
      expect(code).toBe(0);
      expect(existsSync(join(out, "report.json"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("writes under <data folder>/evals/<job>-<date> by default", async () => {
    const deps = depsFor(new EchoModel());
    const { code } = await runEvalCli(["listener"], deps);
    expect(code).toBe(0);
    const evals = join(deps.env?.["SIB_DATA_DIR"] ?? "", "evals");
    expect(readdirSync(evals)).toEqual(["listener-20261023-140000"]);
    expect(existsSync(join(evals, "listener-20261023-140000", "report.json"))).toBe(true);
  });

  it("never overwrites an earlier report", async () => {
    const out = join(tempDir(), "out");
    expect((await runEvalCli(["listener", "--out", out], depsFor(new EchoModel()))).code).toBe(0);
    const before = readFileSync(join(out, "report.json"), "utf8");
    const again = await runEvalCli(["listener", "--out", out], depsFor(new EchoModel()));
    expect(again.code).toBe(1);
    expect(again.output).toContain("already holds a report");
    expect(readFileSync(join(out, "report.json"), "utf8")).toBe(before);
  });
});

describe("T-010: --record-fixtures writes candidates, never fixtures", () => {
  it("writes <job>/<case>.json that FakeModelClient replays, under the fake's own model name", async () => {
    const record = join(tempDir(), "candidates");
    const { code, output } = await runEvalCli(
      ["bookmaker", "--out", join(tempDir(), "out"), "--record-fixtures", record],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(0);
    expect(output).toContain("20 written");
    expect(readdirSync(join(record, "bookmaker"))).toHaveLength(20);
    const fixture = JSON.parse(
      readFileSync(join(record, "bookmaker", "plants-rain-overnight.json"), "utf8"),
    ) as {
      description: string;
      steps: { model?: string; modelDigest?: string; toolCalls?: unknown[]; content: unknown }[];
    };
    expect(fixture.description).toContain("Recorded from echo-gemma (sha256:echo)");
    expect(fixture.description).toContain("staged eval case plants-rain-overnight");
    expect(fixture.description).toContain("Review by hand");
    expect(fixture.steps).toHaveLength(2);
    expect(fixture.steps[0]?.toolCalls).toEqual([
      { name: "get_forecast", arguments: { hours_ahead: 24 } },
    ]);
    expect(fixture.steps[1]?.content).toMatchObject({ status: "ok", band: "likely" });
    expect(JSON.stringify(fixture)).not.toContain('echo-gemma"');
    expect(
      fixture.steps.every((step) => step.model === undefined && step.modelDigest === undefined),
    ).toBe(true);

    const fake = new FakeModelClient({
      fixturesDir: record,
      scenario: () => "plants-rain-overnight",
    });
    const first = await fake.chat({ job: "bookmaker", messages: [], timeoutMs: 1000 });
    expect(first.model).toBe("fake-gemma");
    expect(first.toolCalls[0]?.name).toBe("get_forecast");
  });

  it("splits a photo case into one fixture per job, and keeps invalid answers as invalid fixtures", async () => {
    const model = new EchoModel();
    model.tamper = (request) =>
      request.job === "inspector" && model.requests.length === 1 ? "{broken" : undefined;
    const record = join(tempDir(), "candidates");
    const photos = await photosFor("inspector");
    await runEvalCli(
      [
        "inspector",
        "--photos",
        photos,
        "--out",
        join(tempDir(), "out"),
        "--record-fixtures",
        record,
      ],
      depsFor(model),
    );
    expect(readdirSync(join(record, "inspector"))).toHaveLength(20);
    expect(readdirSync(join(record, "bookmaker"))).toHaveLength(20);
    const retried = JSON.parse(
      readFileSync(join(record, "inspector", "plants-dry-soil.json"), "utf8"),
    ) as {
      description: string;
      steps: { content: unknown }[];
    };
    expect(retried.steps[0]?.content).toBe("{broken");
    expect(retried.description).toContain("valid");
  });

  it("never overwrites a file that is already there", async () => {
    const record = join(tempDir(), "candidates");
    mkdirSync(join(record, "listener"), { recursive: true });
    writeFileSync(join(record, "listener", "bill.json"), "keep me\n");
    const { output } = await runEvalCli(
      ["listener", "--out", join(tempDir(), "out"), "--record-fixtures", record],
      depsFor(new EchoModel()),
    );
    expect(output).toContain("19 written");
    expect(output).toContain("1 skipped because the file exists");
    expect(readFileSync(join(record, "listener", "bill.json"), "utf8")).toBe("keep me\n");
  });

  it("refuses test/fixtures/gemma/ itself before the model is asked: reviewed files are copied there by hand", async () => {
    const model = new EchoModel();
    const before = readdirSync(join(FIXTURES_DIR, "listener")).length;
    const { code, output } = await runEvalCli(
      ["listener", "--out", join(tempDir(), "out"), "--record-fixtures", FIXTURES_DIR],
      depsFor(model),
    );
    expect(code).toBe(1);
    expect(output).toContain("inside test/fixtures/gemma/");
    expect(model.requests).toHaveLength(0);
    expect(readdirSync(join(FIXTURES_DIR, "listener")).length).toBe(before);
  });

  it("refuses a record folder inside the repository that git does not ignore, before the model is asked", async () => {
    const model = new EchoModel();
    const record = join(ROOT, "candidate-fixtures-should-not-exist");
    const out = join(tempDir(), "out");
    const { code, output } = await runEvalCli(
      ["listener", "--out", out, "--record-fixtures", record],
      depsFor(model),
    );
    expect(code).toBe(1);
    expect(output).toContain("could be committed");
    expect(model.requests).toHaveLength(0);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a <folder>/<job> symlink that leads into test/fixtures/gemma/, before the model is asked", async () => {
    const model = new EchoModel();
    const record = tempDir();
    symlinkSync(join(FIXTURES_DIR, "listener"), join(record, "listener"));
    const before = readdirSync(join(FIXTURES_DIR, "listener")).sort();
    const { code, output } = await runEvalCli(
      ["listener", "--out", join(tempDir(), "out"), "--record-fixtures", record],
      depsFor(model),
    );
    expect(code).toBe(1);
    expect(output).toContain("inside test/fixtures/gemma/");
    expect(model.requests).toHaveLength(0);
    expect(readdirSync(join(FIXTURES_DIR, "listener")).sort()).toEqual(before);
  });

  it("a symlink made after the first check is still caught before anything is written", () => {
    const record = tempDir();
    symlinkSync(join(FIXTURES_DIR, "listener"), join(record, "listener"));
    const before = readdirSync(join(FIXTURES_DIR, "listener")).sort();
    const run = {
      record: { id: "would-be-fixture" },
      calls: [
        {
          job: "listener",
          toolsOffered: false,
          images: 0,
          content: "{}",
          toolCalls: [],
          model: "m",
          modelDigest: undefined,
          error: undefined,
          ms: 1,
        },
      ],
    } as unknown as Parameters<typeof writeCandidateFixtures>[1][number];
    expect(() =>
      writeCandidateFixtures(record, [run], { model: "m", modelDigest: null, date: "d" }),
    ).toThrow(/inside test\/fixtures\/gemma/);
    expect(readdirSync(join(FIXTURES_DIR, "listener")).sort()).toEqual(before);
  });
});

describe("sib eval: bad input is named before the model is asked", () => {
  it("photo sets need --photos and say what to stage", async () => {
    const model = new EchoModel();
    const { code, output } = await runEvalCli(
      ["inspector", "--out", join(tempDir(), "out")],
      depsFor(model),
    );
    expect(code).toBe(1);
    expect(output).toContain("pass --photos <dir>");
    expect(output).toContain("inspector-01-plants-dry-soil.jpg: Two or three pots");
    expect(model.requests).toHaveLength(0);
  });

  it("lists every staged photo that is missing", async () => {
    const photos = await stagedPhotos(["inspector-01-plants-dry-soil.jpg"]);
    const { code, output } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", join(tempDir(), "out")],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain("19 staged photo(s) missing");
    expect(output).toContain("inspector-12-not-plants.jpg: A coffee mug");
  });

  it("refuses a file that is not a photo", async () => {
    const photos = await photosFor("inspector");
    writeFileSync(
      join(photos, "inspector-01-plants-dry-soil.jpg"),
      "not an image at all, just text",
    );
    const { code, output } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", join(tempDir(), "out")],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain("is not a usable photo");
  });

  it("refuses a folder named like a photo, with a message and not a stack trace", async () => {
    const model = new EchoModel();
    const photos = await photosFor("inspector");
    rmSync(join(photos, "inspector-01-plants-dry-soil.jpg"));
    mkdirSync(join(photos, "inspector-01-plants-dry-soil.jpg"));
    const { code, output } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", join(tempDir(), "out")],
      depsFor(model),
    );
    expect(code).toBe(1);
    expect(output).toContain("is not a regular file");
    expect(model.requests).toHaveLength(0);
  });

  it("refuses a pipe named like a photo instead of waiting on it forever", async () => {
    const photos = await photosFor("inspector");
    rmSync(join(photos, "inspector-02-plants-moist-soil.jpg"));
    execFileSync("mkfifo", [join(photos, "inspector-02-plants-moist-soil.jpg")]);
    const { code, output } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", join(tempDir(), "out")],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain("is not a regular file");
  });

  it("names a photo that two cases share once", async () => {
    const dir = tempDir();
    const path = join(dir, "cases.json");
    const entry = (id: string) => ({
      id,
      chore: "plants",
      text: "water",
      now: "2026-07-14 18:30",
      weather: "mild",
      photo: "shared.jpg",
      staging: "the one shared pot",
    });
    writeFileSync(path, JSON.stringify({ job: "inspector", cases: [entry("one"), entry("two")] }));
    const { code, output } = await runEvalCli(
      ["inspector", "--cases", path, "--photos", tempDir()],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain("1 staged photo(s) missing");
    expect(output.match(/shared\.jpg/g)).toHaveLength(1);
  });

  it("NFR-002: a photo with EXIF and GPS reaches the model without any metadata", async () => {
    const model = new EchoModel();
    const photos = await photosFor("inspector");
    const original = await syntheticPhoto({ withMetadata: true, orientation: 6 });
    expect(original.includes(Buffer.from(PLANTED_METADATA[0] ?? ""))).toBe(true);
    writeFileSync(join(photos, "inspector-01-plants-dry-soil.jpg"), original);
    const { code } = await runEvalCli(
      ["inspector", "--photos", photos, "--out", join(tempDir(), "out")],
      depsFor(model),
    );
    expect(code).toBe(0);
    const sent = model.requests.find((request) => request.job === "inspector")?.images?.[0];
    expect(sent).toBeDefined();
    const bytes = Buffer.from(sent ?? new Uint8Array());
    for (const marker of PLANTED_METADATA) {
      expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
    const metadata = await sharp(bytes).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    // The orientation was applied to the pixels (portrait now), not left as a tag.
    expect(metadata.orientation ?? 1).toBe(1);
    expect(Math.max(metadata.width ?? 0, metadata.height ?? 0)).toBeLessThanOrEqual(1024);
  });

  it("a case file with a mistake names the file and the case", async () => {
    const dir = tempDir();
    const path = join(dir, "cases.json");
    writeFileSync(
      path,
      JSON.stringify({
        job: "listener",
        cases: [
          { id: "ok-one", text: "hi" },
          { id: "Bad Id", text: "hi" },
        ],
      }),
    );
    const { code, output } = await runEvalCli(
      ["listener", "--cases", path],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain(`Invalid case file ${path}`);
    expect(output).toContain("cases.1.id");
  });

  it("a photo name cannot be a path out of the --photos folder", async () => {
    const dir = tempDir();
    const path = join(dir, "cases.json");
    writeFileSync(
      path,
      JSON.stringify({
        job: "inspector",
        cases: [
          {
            id: "escape",
            chore: "plants",
            text: "water",
            now: "2026-07-14 18:30",
            weather: "mild",
            photo: "../secret.jpg",
            staging: "anything at all",
          },
        ],
      }),
    );
    const { code, output } = await runEvalCli(
      ["inspector", "--cases", path],
      depsFor(new EchoModel()),
    );
    expect(code).toBe(1);
    expect(output).toContain("cases.0.photo");
  });

  it("rejects a job that is not one, an extra word and an unknown option", async () => {
    for (const args of [[], ["gardener"], ["listener", "extra"], ["listener", "--nope"]]) {
      const { code, output } = await runEvalCli(args, depsFor(new EchoModel()));
      expect(code).toBe(1);
      expect(output).toContain(
        "Usage: sib eval <listener|bookmaker|inspector|judge|safety|laundry-planner>",
      );
    }
  });

  it("--help lists the exit codes", async () => {
    const { code, output } = await runEvalCli(["--help"], depsFor(new EchoModel()));
    expect(code).toBe(0);
    expect(output).toContain("3  target missed");
    expect(output).toContain("2  Gemma unreachable");
  });
});

describe("T-010: sib eval is a subcommand of the sib CLI", () => {
  it("runs end to end from src/cli.ts on the fake model", async () => {
    const out = join(tempDir(), "out");
    const { stderr } = await run(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "eval", "safety", "--out", out],
      { cwd: ROOT, env: { ...process.env, SIB_FAKE_MODEL: "1", SIB_DATA_DIR: tempDir() } },
    );
    expect(stderr).toContain("FAKE MODEL");
    expect(stderr).toContain("TARGET MET");
    expect(existsSync(join(out, "report.md"))).toBe(true);
  }, 60_000);

  it("exits with the command's code (1 for a bad job) and lists eval in the usage text", async () => {
    await expect(
      run(process.execPath, ["--import", "tsx", "src/cli.ts", "eval", "gardener"], {
        cwd: ROOT,
        env: { ...process.env, SIB_FAKE_MODEL: "1" },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown job: gardener") as string,
    });
    await expect(
      run(process.execPath, ["--import", "tsx", "src/cli.ts"], { cwd: ROOT }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("eval <job>") as string });
  }, 60_000);
});
