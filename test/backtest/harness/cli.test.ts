import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildChatBody } from "../../../src/server/model/ollama-wire.js";
import { reportFile, sliceSnapshot, snapshotOnDisk, tempDir } from "./support.js";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("T-015 done-when: `sib backtest` is a subcommand of the sib CLI", () => {
  it("runs end to end on the fake model, on a 2-week synthetic slice, from src/cli.ts", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    const { stderr } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "backtest",
        "--snapshot",
        snapshotDir,
        "--out",
        out,
        "--fake-model",
        "--strategies",
        "rule,fixed,e2b,e4b",
      ],
      { cwd: ROOT, env: { ...process.env, SIB_FAKE_MODEL: "" } },
    );
    expect(stderr).toContain("Estimate (decisions to go");
    expect(stderr).toContain("Report (complete)");
    expect(existsSync(reportFile(out, "md"))).toBe(true);
    expect(readFileSync(reportFile(out, "md"), "utf8")).toContain("## Headline: hold-out");
  }, 60_000);

  it("lists backtest in the usage text", async () => {
    await expect(
      run(process.execPath, ["--import", "tsx", "src/cli.ts"], { cwd: ROOT }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("backtest") as string });
  }, 30_000);
});

describe("NFR-012: a fixed sampling seed for the Ollama calls", () => {
  const request = {
    job: "bookmaker",
    messages: [{ role: "user" as const, content: "hi" }],
    timeoutMs: 1000,
  };

  it("sends the seed as an option when one is set", () => {
    const body = buildChatBody(request, { model: "m", keepAlive: "1h", temperature: 0, seed: 7 });
    expect(body.options).toEqual({ temperature: 0, seed: 7 });
  });

  it("sends none by default, so the live app is unchanged", () => {
    const body = buildChatBody(request, { model: "m", keepAlive: "1h", temperature: 0 });
    expect(body.options).toEqual({ temperature: 0 });
  });
});
