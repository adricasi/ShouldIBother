import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FileDecisionStore,
  LOCK_FILE,
  RunDirectoryError,
  acquireLock,
  backtestCommand,
  parseDecisionFile,
  readRunFile,
} from "../../../src/backtest/harness/index.js";
import {
  configDirWith,
  fakeOllama,
  reportFile,
  sliceSnapshot,
  snapshotOnDisk,
  tempDir,
} from "./support.js";

const RULE = ["--fake-model", "--strategies", "rule"];

async function firstRun(): Promise<{ snapshotDir: string; out: string }> {
  const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
  const out = tempDir();
  const code = await backtestCommand(
    ["--snapshot", snapshotDir, "--out", out, ...RULE],
    () => undefined,
  );
  expect(code).toBe(0);
  return { snapshotDir, out };
}

describe("--restart deletes only this harness's own files", () => {
  it("refuses a directory with an unrelated file and deletes nothing", async () => {
    const { snapshotDir, out } = await firstRun();
    writeFileSync(join(out, "thesis-notes.txt"), "keep me");
    const before = readdirSync(out).sort();
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...RULE, "--restart"],
      (l) => lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("did not write (thesis-notes.txt)");
    expect(readdirSync(out).sort()).toEqual(before);
    expect(readFileSync(join(out, "thesis-notes.txt"), "utf8")).toBe("keep me");
  });

  it("removes the run's files, and only those, from a dedicated directory", async () => {
    const { snapshotDir, out } = await firstRun();
    const oldDecisions = readFileSync(join(out, "decisions.jsonl"), "utf8");
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, ...RULE, "--restart", "--splits", "holdout"],
      () => undefined,
    );
    expect(code).toBe(0);
    expect(readFileSync(join(out, "decisions.jsonl"), "utf8").length).toBeLessThan(
      oldDecisions.length,
    );
    expect(
      readdirSync(out).every((name) =>
        /^(run\.json|decisions\.jsonl|performance\.json|report-.*)$/.test(name),
      ),
    ).toBe(true);
  });

  it("deletes nothing when the models do not answer", async () => {
    const { snapshotDir, out } = await firstRun();
    const ollama = fakeOllama();
    ollama.setOnline(false);
    const lines: string[] = [];
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--strategies", "rule,e4b", "--restart"],
      (l) => lines.push(l),
      { configDir: configDirWith({ e4b: { tag: "gemma4:e4b" } }), fetch: ollama.fetch, env: {} },
    );
    expect(code).toBe(2);
    expect(existsSync(join(out, "decisions.jsonl"))).toBe(true);
    expect(existsSync(join(out, "run.json"))).toBe(true);
  });

  it("refuses a first run into a directory that holds unrelated files", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    writeFileSync(join(out, "photo.jpg"), "x");
    const lines: string[] = [];
    expect(
      await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...RULE], (l) =>
        lines.push(l),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("photo.jpg");
    expect(readdirSync(out)).toEqual(["photo.jpg"]);
  });
});

describe("resume safety", () => {
  it("rewrites decisions.jsonl only when a torn last line was dropped, through a temporary file", async () => {
    const { out } = await firstRun();
    const path = join(out, "decisions.jsonl");
    const text = readFileSync(path, "utf8");
    const before = statSync(path);
    FileDecisionStore.open(out);
    // Untouched: same bytes, same inode (no rewrite), no temporary file.
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(statSync(path).ino).toBe(before.ino);

    writeFileSync(path, `${text}{"v":1,"strategy":"ru`);
    const store = FileDecisionStore.open(out);
    expect(store.records().length).toBe(text.trim().split("\n").length);
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(readdirSync(out).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("treats a bad line followed by a newline as damage, not as a torn write", () => {
    expect(() => parseDecisionFile("{broken\n")).toThrow(RunDirectoryError);
    expect(parseDecisionFile('{"v":1,"strat')).toEqual({ records: [], torn: true });
  });

  it("gives a clear one-line error for a damaged run.json (not JSON, wrong shape)", async () => {
    const { snapshotDir, out } = await firstRun();
    for (const content of ["{not json", JSON.stringify({ schemaVersion: 1 })]) {
      writeFileSync(join(out, "run.json"), content);
      const lines: string[] = [];
      const code = await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...RULE], (l) =>
        lines.push(l),
      );
      expect(code).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/run\.json is damaged .*--restart/);
    }
    expect(() => readRunFile(out)).toThrow(RunDirectoryError);
  });

  it("writes run.json atomically: no temporary file is left behind", async () => {
    const { out } = await firstRun();
    expect(readdirSync(out).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readRunFile(out)?.schemaVersion).toBe(1);
  });

  it("refuses a directory that has decisions.jsonl but no run.json", async () => {
    const { snapshotDir, out } = await firstRun();
    unlinkSync(join(out, "run.json"));
    const lines: string[] = [];
    const code = await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...RULE], (l) =>
      lines.push(l),
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("has decisions.jsonl but no run.json");
  });
});

describe("one process per --out", () => {
  it("refuses a second process while the first holds the lock, and frees it afterwards", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    const release = acquireLock(out);
    expect(() => acquireLock(out)).toThrow(/in use by another sib backtest/);
    const lines: string[] = [];
    expect(
      await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...RULE], (l) =>
        lines.push(l),
      ),
    ).toBe(1);
    expect(lines.join("\n")).toContain("in use by another sib backtest");
    expect(readdirSync(out)).toEqual([LOCK_FILE]);
    release();
    expect(existsSync(join(out, LOCK_FILE))).toBe(false);

    expect(
      await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...RULE], () => undefined),
    ).toBe(0);
    expect(existsSync(join(out, LOCK_FILE))).toBe(false);
  });

  it("takes over a lock left by a process that is gone", () => {
    const out = tempDir();
    writeFileSync(join(out, LOCK_FILE), "2147483646\n");
    const release = acquireLock(out);
    expect(readFileSync(join(out, LOCK_FILE), "utf8").trim()).toBe(String(process.pid));
    release();
  });
});

describe("reports are named after their strategies and splits", () => {
  it("a smaller run never overwrites a fuller report", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    const all = ["--fake-model", "--strategies", "rule,fixed,e2b,e4b"];
    await backtestCommand(["--snapshot", snapshotDir, "--out", out, ...all], () => undefined);
    const full = readFileSync(reportFile(out, "json"), "utf8");
    const code = await backtestCommand(
      ["--snapshot", snapshotDir, "--out", out, "--fake-model", "--strategies", "rule"],
      () => undefined,
    );
    expect(code).toBe(0);
    expect(readFileSync(reportFile(out, "json"), "utf8")).toBe(full);
    expect(existsSync(reportFile(out, "json", ["rule"]))).toBe(true);
    expect(
      JSON.parse(readFileSync(reportFile(out, "json", ["rule"]), "utf8")).results,
    ).toHaveLength(1);
    // Another split set gets its own file too.
    await backtestCommand(
      [
        "--snapshot",
        snapshotDir,
        "--out",
        out,
        "--fake-model",
        "--strategies",
        "rule",
        "--splits",
        "holdout",
      ],
      () => undefined,
    );
    expect(existsSync(reportFile(out, "md", ["rule"], "holdout"))).toBe(true);
  });
});
