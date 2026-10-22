import { beforeAll, describe, expect, it } from "vitest";

import {
  GemmaStrategy,
  ModelDigestMismatchError,
  ModelOfflineError,
  buildCases,
  type BacktestCase,
  type StrategyId,
} from "../../../src/backtest/harness/index.js";
import { HOUR_MS } from "../../../src/domain/outcomes.js";
import { formatForecast } from "../../../src/server/gemma/forecast-tool.js";
import { forecastFrom } from "../../../src/server/ledger/forecast.js";
import { FakeModelClient } from "../../../src/server/model/fake.js";
import { RULES, sliceSnapshot } from "./support.js";

let cases: readonly BacktestCase[];
beforeAll(async () => {
  cases = buildCases(await sliceSnapshot(), RULES).cases;
});

const plants = (): BacktestCase =>
  cases.find((c) => c.input.chore === "plants" && c.input.alert === null)!;
const lowRule = (): BacktestCase =>
  cases.find((c) => c.input.alert === null && c.input.ruleBand <= 1)!;

function strategy(
  scenario: string,
  options: Partial<ConstructorParameters<typeof GemmaStrategy>[0]> = {},
): { gemma: GemmaStrategy; fake: FakeModelClient } {
  const fake = new FakeModelClient({ scenario: () => scenario });
  const gemma = new GemmaStrategy({
    id: "e4b" satisfies StrategyId,
    model: fake,
    rules: RULES,
    ...options,
  });
  return { gemma, fake };
}

describe("AC-018.1 / AC-003.1: the bookmaker job gets the day-1 forecast as the get_forecast result", () => {
  it("serves exactly the snapshot's hours from the decision hour on, none issued after the decision", async () => {
    const c = plants();
    const { gemma, fake } = strategy("ok");
    const decision = await gemma.decide(c.input);
    gemma.close();

    expect(decision.basis).toBe("gemma");
    expect(decision.gemma?.toolMode).toBe("called");
    const toolMessage = fake.calls
      .flatMap((call) => call.messages)
      .find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(
      formatForecast(forecastFrom(c.input.hours, c.input.decisionAtMs, 24)),
    );
    for (const hour of forecastFrom(c.input.hours, c.input.decisionAtMs, 48)) {
      // Every served hour's day-1 run started before the decision.
      expect(hour.startsAt - 24 * HOUR_MS).toBeLessThan(c.input.decisionAtMs);
    }
    // The prompt tells Gemma the decision time, not the real clock.
    const user = fake.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain(`"now_europe_madrid":"${c.input.date} 19:00"`);
  });

  it("records tool_mode injected when the app makes the call, and no first-answer miss", async () => {
    const { gemma } = strategy("injected", { toolUse: "injected" });
    const decision = await gemma.decide(plants().input);
    gemma.close();
    expect(decision.gemma).toMatchObject({
      toolMode: "injected",
      firstAnswerWithoutTool: null,
      calls: 1,
    });
  });
});

describe("AC-003.6 (harness): the tool-call miss is recorded", () => {
  it("keeps the rule odds when the tool is still not called after the retry", async () => {
    const c = plants();
    const { gemma } = strategy("no-tool-call");
    const decision = await gemma.decide(c.input);
    gemma.close();
    expect(decision).toMatchObject({
      basis: "rule_fallback",
      band: c.input.ruleBand,
      gemma: { failure: "tool_missed", toolMode: "missed", firstAnswerWithoutTool: true },
    });
  });

  it("remembers a missed first answer even when the retry calls the tool", async () => {
    const { gemma } = strategy("no-tool-call-then-tool");
    const decision = await gemma.decide(plants().input);
    gemma.close();
    expect(decision.basis).toBe("gemma");
    expect(decision.gemma).toMatchObject({
      toolMode: "called",
      firstAnswerWithoutTool: true,
      retries: 1,
    });
  });
});

describe("fallbacks keep the rule odds, as the live card does", () => {
  it("falls back when Gemma is unsure (nobody answers its question in a backtest)", async () => {
    const { gemma } = strategy("unsure");
    const decision = await gemma.decide(plants().input);
    gemma.close();
    expect(decision).toMatchObject({ basis: "rule_fallback", gemma: { failure: "unsure" } });
  });

  it("AC-004.3: falls back when the band is two or more bands from the rule without an explanation", async () => {
    const c = lowRule();
    const { gemma } = strategy("disagreement-with-question");
    const decision = await gemma.decide(c.input);
    gemma.close();
    expect(decision).toMatchObject({
      basis: "rule_fallback",
      band: c.input.ruleBand,
      gemma: { failure: "unresolved", gemmaBand: 4 },
    });
    expect(decision.gemma?.bandsFromRule).toBeGreaterThanOrEqual(2);
  });

  it("AC-004.3: accepts a far band that comes with a disagreement reason", async () => {
    const c = lowRule();
    const { gemma } = strategy("disagreement-with-reason");
    const decision = await gemma.decide(c.input);
    gemma.close();
    expect(decision).toMatchObject({ basis: "gemma", band: 4, action: "skip" });
  });

  it("falls back on a timeout, as the live app shows rule odds", async () => {
    const { gemma } = strategy("timeout");
    const decision = await gemma.decide(plants().input);
    gemma.close();
    expect(decision).toMatchObject({ basis: "rule_fallback", gemma: { failure: "timeout" } });
  });

  it("stops the run, instead of recording fallbacks, when the model is unreachable", async () => {
    const { gemma } = strategy("offline");
    await expect(gemma.decide(plants().input)).rejects.toBeInstanceOf(ModelOfflineError);
    gemma.close();
  });

  it("stops the run when the model's digest is not the pinned one (NFR-012)", async () => {
    const { gemma } = strategy("ok-digest", { expectedDigest: "sha256:other" });
    await expect(gemma.decide(plants().input)).rejects.toBeInstanceOf(ModelDigestMismatchError);
    gemma.close();
    const same = strategy("ok-digest", { expectedDigest: "sha256:synthetic0001" });
    expect((await same.gemma.decide(plants().input)).gemma?.modelDigest).toBe(
      "sha256:synthetic0001",
    );
    same.gemma.close();
  });
});

describe("AC-012.1: the safety backstop overrides Gemma", () => {
  it("makes a day with an alert a 'Do it now' without asking Gemma", async () => {
    const c = plants();
    const { gemma, fake } = strategy("ok");
    const decision = await gemma.decide({
      ...c.input,
      alert: { kinds: ["heat"], reason: "Heat: up to 36 °C is forecast." },
    });
    gemma.close();
    expect(decision).toEqual({ action: "do_it", basis: "safety_alert", band: null });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("decision policy", () => {
  it("skips from the 'likely' band: very likely skips, toss-up does the chore", async () => {
    const likely = strategy("disagreement-with-reason");
    const skip = await likely.gemma.decide(lowRule().input);
    likely.gemma.close();
    expect(skip.action).toBe("skip");
    const tossUp = strategy("ok");
    const doIt = await tossUp.gemma.decide(plants().input);
    tossUp.gemma.close();
    expect(doIt).toMatchObject({ band: 2, action: "do_it" });
  });
});
