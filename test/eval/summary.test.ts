import { describe, expect, it } from "vitest";

import { EVAL_JOB_SPECS } from "../../src/eval/jobs.js";
import { neededOf, percentile, summarize } from "../../src/eval/summary.js";
import type { CaseRecord, StepRecord } from "../../src/eval/types.js";

function step(job: string, overrides: Partial<StepRecord> = {}): StepRecord {
  return {
    job,
    valid: true,
    failure: null,
    status: "ok",
    toolMode: job === "bookmaker" ? "called" : null,
    firstAnswerHadToolCall: job === "bookmaker" ? true : null,
    calls: job === "bookmaker" ? 2 : 1,
    retries: 0,
    latencyMs: 1000,
    promptVersion: `${job}.v1`,
    error: null,
    output: null,
    ...overrides,
  };
}

function record(id: string, steps: StepRecord[], primary = steps[0]?.job ?? "x"): CaseRecord {
  const bad = steps.find((entry) => !entry.valid);
  return {
    id,
    note: null,
    steps,
    valid: bad === undefined,
    failure: bad?.failure ?? null,
    primaryValid: steps.find((entry) => entry.job === primary)?.valid ?? false,
    toolMode: steps.find((entry) => entry.job === "bookmaker")?.toolMode ?? null,
    calls: steps.reduce((sum, entry) => sum + entry.calls, 0),
    retries: steps.reduce((sum, entry) => sum + entry.retries, 0),
    latencyMs: steps.reduce((sum, entry) => sum + entry.latencyMs, 0),
    answerKey: "ok",
    matchesExpectation: null,
  };
}

const failed = (job: string, failure = "invalid"): StepRecord =>
  step(job, { valid: false, failure, status: null, toolMode: null, retries: 1 });

describe("NFR-004: the summary maths of sib eval", () => {
  it("needs 19 of 20, and the same share of a set of another size", () => {
    expect(neededOf(20)).toBe(19);
    expect(neededOf(10)).toBe(10);
    expect(neededOf(40)).toBe(38);
    expect(neededOf(1)).toBe(1);
  });

  it("takes the nearest-rank percentile of the sorted times", () => {
    const times = Array.from({ length: 20 }, (_unused, index) => (index + 1) * 100);
    expect(percentile(times, 50)).toBe(1000);
    expect(percentile(times, 95)).toBe(1900);
    expect(percentile(times, 100)).toBe(2000);
    expect(percentile([], 95)).toBe(0);
    expect(percentile([700], 95)).toBe(700);
  });

  it("19 valid of 20 meets the target, 18 does not", () => {
    const spec = EVAL_JOB_SPECS.listener;
    const make = (bad: number) =>
      Array.from({ length: 20 }, (_unused, index) =>
        record(`c${index}`, [index < bad ? failed("listener") : step("listener")]),
      );
    expect(summarize(make(1), spec)).toMatchObject({ primaryValid: 19, targetMet: true });
    expect(summarize(make(2), spec)).toMatchObject({ primaryValid: 18, targetMet: false });
    expect(summarize(make(0), spec).validFirstTry).toBe(20);
  });

  it("counts a question from Gemma as a valid answer and the retry as not first-try", () => {
    const records = [
      record("a", [step("safety", { status: "unsure" })]),
      record("b", [step("safety", { retries: 1 })]),
      record("c", [step("safety")]),
    ];
    const summary = summarize(records, EVAL_JOB_SPECS.safety);
    expect(summary).toMatchObject({ primaryValid: 3, validFirstTry: 2, unsure: 1 });
  });

  it("reports the bookmaker's tool use and fails the target when it is not used", () => {
    const spec = EVAL_JOB_SPECS.bookmaker;
    const records = Array.from({ length: 20 }, (_unused, index) =>
      record(`c${index}`, [
        index < 3
          ? step("bookmaker", { toolMode: "missed", firstAnswerHadToolCall: false })
          : index === 3
            ? step("bookmaker", { toolMode: "injected", firstAnswerHadToolCall: null })
            : step("bookmaker"),
      ]),
    );
    const summary = summarize(records, spec);
    expect(summary.toolUse).toEqual({
      bookmakerRuns: 20,
      called: 16,
      injected: 1,
      missed: 3,
      firstAnswerWithTool: 16,
    });
    expect(summary.criteria.find((entry) => entry.id === "tool_use")).toMatchObject({
      count: 17,
      met: false,
    });
    expect(summary.targetMet).toBe(false);
  });

  it("NFR-004: photo judgement within 15 s in 19 of 20, inspector and bookmaker added together", () => {
    const spec = EVAL_JOB_SPECS.inspector;
    const chain = (inspectorMs: number, bookmakerMs: number) =>
      record(
        "c",
        [
          step("inspector", { latencyMs: inspectorMs }),
          step("bookmaker", { latencyMs: bookmakerMs }),
        ],
        "inspector",
      );
    const make = (slow: number) =>
      Array.from({ length: 20 }, (_unused, index) =>
        index < slow ? chain(8000, 7001) : chain(8000, 7000),
      );
    expect(summarize(make(1), spec)).toMatchObject({ withinPhotoBudget: 19, targetMet: true });
    const missed = summarize(make(2), spec);
    expect(missed).toMatchObject({ withinPhotoBudget: 18, targetMet: false });
    expect(missed.latencyMs).toEqual({ p50: 15000, p95: 15001, max: 15001 });
  });

  it("a photo case whose inspector asks a question did not judge the photo in time", () => {
    const records = Array.from({ length: 20 }, (_unused, index) =>
      index === 0
        ? record("c", [step("inspector", { status: "unsure" })], "inspector")
        : record("c", [step("inspector"), step("bookmaker")], "inspector"),
    );
    expect(summarize(records, EVAL_JOB_SPECS.inspector)).toMatchObject({
      primaryValid: 20,
      withinPhotoBudget: 19,
      targetMet: true,
    });
  });

  it("the inspector's own validity is the target; a failing bookmaker costs the photo budget", () => {
    const records = Array.from({ length: 20 }, (_unused, index) =>
      index < 2
        ? record("c", [step("inspector"), failed("bookmaker", "tool_missed")], "inspector")
        : record("c", [step("inspector"), step("bookmaker")], "inspector"),
    );
    const summary = summarize(records, EVAL_JOB_SPECS.inspector);
    expect(summary).toMatchObject({ primaryValid: 20, allValid: 18, withinPhotoBudget: 18 });
    expect(summary.targetMet).toBe(false);
    expect(summary.failures).toEqual({ tool_missed: 2 });
  });

  it("counts how many cases match what the case set expected, separately from the target", () => {
    const records = [
      { ...record("a", [step("judge")]), matchesExpectation: true },
      { ...record("b", [step("judge")]), matchesExpectation: false },
      record("c", [step("judge")]),
    ];
    expect(summarize(records, EVAL_JOB_SPECS.judge).expectation).toEqual({ matched: 1, total: 2 });
  });

  it("an empty run never meets the target", () => {
    expect(summarize([], EVAL_JOB_SPECS.listener).targetMet).toBe(false);
  });
});
