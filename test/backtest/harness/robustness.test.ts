import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_ATTEMPTS,
  MemoryDecisionStore,
  ModelOfflineError,
  ModelStalledError,
  OFFLINE_WAIT_MS,
  backtestCommand,
  buildCases,
  parseDecisionLines,
  runBacktest,
  type BacktestCase,
  type DecisionInput,
  type Strategy,
  type StrategyDecision,
} from "../../../src/backtest/harness/index.js";
import { FakeModelClient } from "../../../src/server/model/fake.js";
import { RULES, sliceSnapshot, snapshotOnDisk, tempDir } from "./support.js";

const ok: StrategyDecision = { action: "skip", basis: "gemma", band: 3 };
const fallback: StrategyDecision = { action: "do_it", basis: "rule_fallback", band: 2 };

async function someCases(count: number): Promise<BacktestCase[]> {
  return buildCases(await sliceSnapshot(), RULES).cases.slice(0, count);
}

/** A Gemma-like strategy whose behaviour per call is scripted. */
function scripted(
  script: (input: DecisionInput, call: number) => StrategyDecision | Error,
  reachable: () => boolean = () => true,
): Strategy & { calls: number } {
  const strategy = {
    id: "e4b" as const,
    kind: "gemma" as const,
    calls: 0,
    decide(input: DecisionInput): Promise<StrategyDecision> {
      strategy.calls += 1;
      const result = script(input, strategy.calls);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    reachable: () => Promise.resolve(reachable()),
    release: () => Promise.resolve(),
  };
  return strategy;
}

describe("NFR-005: an outage waits for the model, bounded, with a growing pause", () => {
  it("waits 5 s, 10 s, 20 s ... for the model and then carries on with the same day", async () => {
    const cases = await someCases(2);
    let checks = 0;
    const strategy = scripted(
      (_input, call) => (call === 1 ? new ModelOfflineError("down") : ok),
      () => ++checks >= 3,
    );
    const sleeps: number[] = [];
    const store = new MemoryDecisionStore();
    const lines: string[] = [];
    const outcome = await runBacktest({
      cases,
      strategies: [strategy],
      store,
      log: (l) => lines.push(l),
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      probe: 0,
    });
    expect(sleeps).toEqual([5000, 10_000, 20_000]);
    expect(outcome.status).toBe("complete");
    expect(store.records()).toHaveLength(2);
    expect(lines.some((l) => l.includes("Gemma is back"))).toBe(true);
  });

  it("gives up after the bound (10 minutes by default) and stops with the error", async () => {
    expect(OFFLINE_WAIT_MS).toBe(600_000);
    const strategy = scripted(
      () => new ModelOfflineError("down"),
      () => false,
    );
    const sleeps: number[] = [];
    const store = new MemoryDecisionStore();
    await expect(
      runBacktest({
        cases: await someCases(2),
        strategies: [strategy],
        store,
        log: () => undefined,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        probe: 0,
      }),
    ).rejects.toBeInstanceOf(ModelOfflineError);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(OFFLINE_WAIT_MS);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000);
    expect(store.records()).toHaveLength(0);
  });

  it("does not wait forever for a model that reports itself up but keeps failing", async () => {
    const strategy = scripted(() => new ModelOfflineError("down"));
    await expect(
      runBacktest({
        cases: await someCases(1),
        strategies: [strategy],
        store: new MemoryDecisionStore(),
        log: () => undefined,
        sleep: () => Promise.resolve(),
        probe: 0,
      }),
    ).rejects.toBeInstanceOf(ModelOfflineError);
    expect(strategy.calls).toBeLessThanOrEqual(5);
  });
});

describe("NFR-005: a call that times out is not recorded as a rule fallback", () => {
  it("leaves the day undecided, tries it again later and records the answer it then gets", async () => {
    const cases = await someCases(3);
    const strategy = scripted((_input, call) =>
      call === 2 ? new ModelStalledError("slow", fallback) : ok,
    );
    const store = new MemoryDecisionStore();
    const outcome = await runBacktest({
      cases,
      strategies: [strategy],
      store,
      log: () => undefined,
      probe: 0,
    });
    expect(outcome.status).toBe("complete");
    expect(store.records().map((r) => r.basis)).toEqual(["gemma", "gemma", "gemma"]);
  });

  it("keeps a stuck day undecided between runs and records the fallback only after the cap", async () => {
    const cases = await someCases(2);
    const strategy = scripted((input) =>
      input.date === cases[0]?.input.date && input.chore === cases[0].input.chore
        ? new ModelStalledError("slow", fallback)
        : ok,
    );
    const store = new MemoryDecisionStore();
    const counts = new Map<string, number>();
    const attempts = {
      bump(key: string): number {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key) ?? 0;
      },
    };
    const options = {
      cases,
      strategies: [strategy],
      store,
      log: () => undefined,
      probe: 0,
      attempts,
    };

    const first = await runBacktest(options);
    expect(first.status).toBe("incomplete");
    expect(first.remaining).toBe(1);
    expect(store.records()).toHaveLength(1); // the other day; the stuck one is not recorded
    expect([...counts.values()]).toEqual([2]); // the pass, then one more try

    const second = await runBacktest(options);
    expect(second.status).toBe("complete");
    expect(counts.size).toBe(1);
    expect([...counts.values()]).toEqual([MAX_ATTEMPTS]);
    expect(
      store
        .records()
        .map((r) => r.basis)
        .sort(),
    ).toEqual(["gemma", "rule_fallback"]);
  });
});

describe("command: unattended runs end with distinct exit codes and persisted attempts", () => {
  it("exit 4 while days wait for a retry, run.json keeps the tries, a resume ends at 0 with fallbacks", async () => {
    const snapshotDir = await snapshotOnDisk(await sliceSnapshot());
    const out = tempDir();
    const model = new FakeModelClient({ scenario: () => "timeout" });
    const args = [
      "--snapshot",
      snapshotDir,
      "--out",
      out,
      "--strategies",
      "e4b",
      "--splits",
      "holdout",
    ];
    const deps = { createModel: () => Promise.resolve(model), sleep: () => Promise.resolve() };

    const lines: string[] = [];
    const first = await backtestCommand(args, (l) => lines.push(l), deps);
    expect(first).toBe(4);
    expect(lines.join("\n")).toContain("left undecided");
    const decided = parseDecisionLines(readFileSync(join(out, "decisions.jsonl"), "utf8"));
    // Only the days that reached the cap were recorded, as what the live app would show.
    expect(decided.length).toBeGreaterThan(0);
    expect(
      decided.every((r) => r.basis === "rule_fallback" && r.gemma?.failure === "timeout"),
    ).toBe(true);
    const run = JSON.parse(readFileSync(join(out, "run.json"), "utf8")) as {
      attempts: Record<string, number>;
    };
    expect(Object.keys(run.attempts).length).toBeGreaterThan(decided.length);

    const second = await backtestCommand(args, () => undefined, deps);
    expect(second).toBe(0);
    const all = parseDecisionLines(readFileSync(join(out, "decisions.jsonl"), "utf8"));
    expect(all.length).toBeGreaterThan(decided.length);
    expect(all.every((r) => r.basis === "rule_fallback")).toBe(true);
  });
});
