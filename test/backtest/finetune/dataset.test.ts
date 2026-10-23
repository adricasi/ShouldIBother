import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  parseSnapshot,
  serializeSnapshot,
  sortedHabits,
  loadSyntheticHabits,
  toTemplateMessage,
  type FinetuneBuild,
  type FinetuneRow,
  type WeatherSnapshot,
} from "../../../src/backtest/index.js";
import { buildCases } from "../../../src/backtest/harness/cases.js";
import { bookmakerInputFor } from "../../../src/backtest/harness/gemma-strategy.js";
import { CHORES } from "../../../src/domain/chores.js";
import { DECISION_TIMES, OUTCOME_CHORES } from "../../../src/domain/outcomes.js";
import { migrate, openDatabase } from "../../../src/server/db.js";
import {
  BAND_NAMES,
  BOOKMAKER_PROMPT,
  bookmakerOutputSchema,
  runBookmaker,
} from "../../../src/server/gemma/bookmaker.js";
import { GET_FORECAST, formatForecast } from "../../../src/server/gemma/forecast-tool.js";
import { JobRunner } from "../../../src/server/gemma/runner.js";
import { forecastFrom } from "../../../src/server/ledger/forecast.js";
import { MIGRATIONS } from "../../../src/server/migrations/index.js";
import { FakeModelClient } from "../../../src/server/model/fake.js";
import { syntheticSnapshot, withoutVariables } from "../support/synthetic-weather.js";

import { RULES, buildWith, parseLines } from "./support.js";

// Each build is ~5 s on an idle machine, more under coverage.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SNAPSHOT_OPTIONS = {
  startDate: "2026-03-30",
  archiveLastDay: "2026-10-09",
  requestedEndDate: "2026-10-14",
} as const;

let snapshot: WeatherSnapshot;
let build: FinetuneBuild;
let train: FinetuneRow[];
let holdout: FinetuneRow[];

beforeAll(async () => {
  snapshot = await syntheticSnapshot(SNAPSHOT_OPTIONS);
  build = await buildWith(snapshot);
  train = parseLines(build.trainJsonl);
  holdout = parseLines(build.holdoutJsonl);
});

const bandIndex = (name: string): number => BAND_NAMES.findIndex((band) => band === name);

function answerOf(row: FinetuneRow) {
  const last = row.messages.at(-1);
  expect(last?.role).toBe("assistant");
  return bookmakerOutputSchema.parse(JSON.parse(last?.content ?? ""));
}

describe("AC-019.6: a row is the conversation the live bookmaker has", () => {
  it("has the same messages the live bookmaker job sends, for every chore, in both files", async () => {
    const decisions = buildCases(snapshot, RULES, { fallback: "none" }).cases;
    const picks: FinetuneRow[] = OUTCOME_CHORES.flatMap((chore) => [
      train.find((row) => row.chore === chore && row.meta.target?.bands_from_rule === 0),
      train.find((row) => row.chore === chore && (row.meta.target?.bands_from_rule ?? 0) >= 2),
      holdout.find((row) => row.chore === chore),
    ]).filter((row): row is FinetuneRow => row !== undefined);
    expect(picks.length).toBeGreaterThanOrEqual(12);

    for (const row of picks) {
      const decision = decisions.find((c) => c.key === row.id);
      expect(decision, row.id).toBeDefined();
      // The live job, with the fake model and the live prompt, sent over the same input.
      const db = openDatabase(":memory:");
      migrate(db, MIGRATIONS);
      db.pragma("foreign_keys = OFF");
      const fake = new FakeModelClient({ scenario: () => "backtest-toss-up" });
      const runner = new JobRunner({ model: fake, db, now: Date.now });
      // The fixture's toss-up may be far from the rule band and so be refused by the job's own
      // check; what the job sent with its first answer call is what this test compares.
      await runBookmaker(
        runner,
        bookmakerInputFor(decision!.input, {
          rules: RULES,
          habits: loadSyntheticHabits(),
          cardId: 1,
        }),
        BOOKMAKER_PROMPT,
      );
      db.close();

      // Call 1 offered the tool; call 2 (the answer call) carried the whole conversation.
      expect(fake.calls[0]?.tools).toEqual([GET_FORECAST]);
      const sent = fake.calls[1]?.messages ?? [];
      expect(sent.map(toTemplateMessage)).toEqual(row.messages.slice(0, 4));

      expect(row.messages[0]?.content).toBe(BOOKMAKER_PROMPT.text);
      expect(row.tools).toEqual([
        {
          type: "function",
          function: {
            name: GET_FORECAST.name,
            description: GET_FORECAST.description,
            parameters: GET_FORECAST.parameters,
          },
        },
      ]);

      // What the data message and the tool result contain, from the decision itself.
      const user = String(row.messages[1]?.content);
      expect(user).toContain(`"person_wrote":${JSON.stringify(CHORES[row.chore].title)}`);
      expect(user).toContain(`"rule_band":"${BAND_NAMES[decision!.input.ruleBand]}"`);
      expect(user).toContain(JSON.stringify(sortedHabits(loadSyntheticHabits()).balcony_plants));
      const shown = forecastFrom(decision!.input.toolHours, decision!.input.decisionAtMs, 24);
      expect(row.messages[3]?.content).toBe(formatForecast(shown));
    }
  });

  it("answers training rows with the target band, a reason and a settle time the live job accepts", () => {
    expect(train.length).toBeGreaterThan(400);
    for (const row of train) {
      const answer = answerOf(row);
      expect(row.messages).toHaveLength(5);
      expect(answer.status).toBe("ok");
      expect(answer.band).toBe(row.meta.target?.band);
      expect((answer.reason ?? "").length).toBeLessThanOrEqual(140);
      expect(answer.reason).toMatch(/, so /);
    }
  });

  it("adds a disagreement_reason exactly when the target is two or more bands from the rule band", () => {
    let far = 0;
    let near = 0;
    for (const row of train) {
      const answer = answerOf(row);
      const distance = Math.abs(bandIndex(answer.band ?? "") - bandIndex(row.meta.rule_band));
      expect(row.meta.target?.bands_from_rule).toBe(distance);
      if (distance >= 2) {
        far += 1;
        expect((answer.disagreement_reason ?? "").trim()).not.toBe("");
        expect(answer.disagreement_reason).toMatch(/^In \d+ of \d+ similar days/);
      } else {
        near += 1;
        expect(answer.disagreement_reason).toBeUndefined();
      }
    }
    // The check is only worth something if both kinds of row exist.
    expect(far).toBeGreaterThan(20);
    expect(near).toBeGreaterThan(20);
  });

  it("ends hold-out rows at the tool result: no answer and no target", () => {
    expect(holdout.length).toBeGreaterThan(100);
    for (const row of holdout) {
      expect(row.split).toBe("holdout");
      expect(row.messages).toHaveLength(4);
      expect(row.messages.at(-1)?.role).toBe("tool");
      expect(row.meta.target).toBeUndefined();
      expect(typeof row.meta.outcome_delivered).toBe("boolean");
    }
  });

  it("uses the fixed synthetic habit profile in every row", () => {
    const habits = JSON.stringify(sortedHabits(loadSyntheticHabits()));
    for (const row of [...train, ...holdout]) {
      const data = JSON.parse(
        String(row.messages[1]?.content).replace(/<\/?untrusted_data>/g, ""),
      ) as {
        habits: Record<string, string | boolean>;
      };
      expect(JSON.stringify(sortedHabits(data.habits))).toBe(habits);
    }
  });

  it("never fills a prompt from a Historical Forecast or archive value", async () => {
    const gappy = withoutVariables(
      await syntheticSnapshot({ startDate: "2026-08-20", requestedEndDate: "2026-09-04" }),
      "previousRunsDay1",
      ["wind_speed_10m"],
    );
    const result = await buildWith(gappy);
    const rows = [...parseLines(result.trainJsonl), ...parseLines(result.holdoutJsonl)];
    // Line-dry and tonight read the wind; the day-1 wind is missing, so those days are left out.
    expect(rows.some((row) => row.chore === "laundry_line")).toBe(false);
    expect(rows.some((row) => row.chore === "laundry_tonight")).toBe(false);
    expect(rows.some((row) => row.chore === "plants")).toBe(true);
    expect(result.manifest.rows.train.skipped.fallback_forecast).toBeGreaterThan(0);
    expect(result.manifest.rows.holdout.skipped.fallback_forecast).toBeGreaterThan(0);
  });

  it("leaves out days the fixed backstop turns into a 'Do it now' alert", () => {
    const alerts = buildCases(snapshot, RULES, { fallback: "none" }).cases.filter(
      (c) => c.input.alert !== null,
    );
    expect(alerts.length).toBeGreaterThan(0);
    const ids = new Set([...train, ...holdout].map((row) => row.id));
    expect(alerts.filter((c) => ids.has(c.key))).toEqual([]);
    const counted =
      build.manifest.rows.train.skipped.safety_alert +
      build.manifest.rows.holdout.skipped.safety_alert;
    expect(counted).toBeGreaterThan(0);
    expect(counted).toBeLessThanOrEqual(alerts.length);
  });
});

describe("AC-019.1, AC-019.5: the split and the targets", () => {
  it("trains on 1 Apr-31 Aug and holds out 1 Sep to the snapshot's last day, with no date in both", () => {
    expect(train.every((row) => row.date >= "2026-04-01" && row.date <= "2026-08-31")).toBe(true);
    expect(holdout.every((row) => row.date >= "2026-09-01" && row.date <= "2026-10-09")).toBe(true);
    const keys = new Set(train.map((row) => row.id));
    expect(holdout.filter((row) => keys.has(row.id))).toEqual([]);
    expect(new Set(train.map((row) => row.date)).has("2026-09-01")).toBe(false);
  });

  it("AC-018.1: decides every row at the chore's fixed time and shows only hours from then on", () => {
    for (const row of [...train, ...holdout]) {
      const data = JSON.parse(
        String(row.messages[1]?.content).replace(/<\/?untrusted_data>/g, ""),
      ) as { now_europe_madrid: string };
      expect(data.now_europe_madrid, row.id).toBe(`${row.date} ${DECISION_TIMES[row.chore]}`);
      const shown = JSON.parse(
        String(row.messages[3]?.content).replace(/<\/?untrusted_data>/g, ""),
      ) as { hours: { time: string }[] };
      expect(shown.hours.length, row.id).toBeLessThanOrEqual(24);
      // the first hour shown is the decision hour: nothing earlier, so nothing older than the run
      expect(shown.hours[0]?.time, row.id).toBe(`${row.date} ${DECISION_TIMES[row.chore]}`);
    }
  });

  it("shows no hour of September or later in any training row", () => {
    expect(build.trainJsonl).not.toMatch(/2026-(09|1[0-2])-/);
    // and the rows that would have shown some are counted, not silently dropped
    expect(build.manifest.rows.train.skipped.horizon_crosses_split).toBeGreaterThan(0);
  });

  it("keeps the training file identical when the hold-out weather changes", async () => {
    const septemberMs = Date.UTC(2026, 7, 31, 22, 0);
    const harsh = (timeMs: number, variable: string, value: number): number =>
      timeMs < septemberMs
        ? value
        : variable === "precipitation"
          ? 25
          : variable === "temperature_2m"
            ? 12
            : variable === "et0_fao_evapotranspiration"
              ? 0
              : value;
    const altered = await buildWith(
      await syntheticSnapshot({
        ...SNAPSHOT_OPTIONS,
        archiveOverride: harsh,
        forecastOverride: harsh,
      }),
    );
    expect(altered.trainJsonl).toBe(build.trainJsonl);
    // the change is real: hold-out rows differ
    expect(altered.holdoutJsonl).not.toBe(build.holdoutJsonl);
  });
});

describe("AC-019.7: the manifest", () => {
  it("records the prompt version, the rules hash, the snapshot end date and the habit profile", () => {
    const manifest = build.manifest;
    expect(manifest.bookmaker_prompt).toEqual({
      version: BOOKMAKER_PROMPT.version,
      sha256: createHash("sha256").update(BOOKMAKER_PROMPT.text).digest("hex"),
    });
    expect(manifest.rules_json_sha256).toBe("0".repeat(64));
    expect(manifest.snapshot.end_date).toBe("2026-10-09");
    expect(manifest.periods).toEqual({
      train: { from: "2026-04-01", to: "2026-08-31" },
      holdout: { from: "2026-09-01", to: "2026-10-09" },
    });
    expect(manifest.habit_profile).toEqual(sortedHabits(loadSyntheticHabits()));
    expect(JSON.parse(build.manifestJson)).toEqual(manifest);
  });

  it("counts rows per chore and band for training and hold-out, matching the files", () => {
    for (const [split, rows, basis] of [
      ["train", train, "target"],
      ["holdout", holdout, "rule"],
    ] as const) {
      const counts = build.manifest.rows[split];
      expect(counts.rows).toBe(rows.length);
      expect(counts.band_basis).toBe(basis);
      for (const chore of OUTCOME_CHORES) {
        const mine = rows.filter((row) => row.chore === chore);
        const entry = counts.by_chore[chore];
        expect(entry.total).toBe(mine.length);
        expect(Object.values(entry.by_band).reduce((sum, n) => sum + n, 0)).toBe(mine.length);
        for (const band of BAND_NAMES) {
          const expected = mine.filter(
            (row) => (split === "train" ? row.meta.target?.band : row.meta.rule_band) === band,
          ).length;
          expect(entry.by_band[band], `${split} ${chore} ${band}`).toBe(expected);
        }
        expect(entry.delivered).toBe(mine.filter((row) => row.meta.outcome_delivered).length);
      }
    }
  });

  it("records the skip counts and the hash and size of each file", () => {
    const { files, rows } = build.manifest;
    expect(files.train).toEqual({
      name: "train.jsonl",
      rows: train.length,
      sha256: createHash("sha256").update(build.trainJsonl).digest("hex"),
    });
    expect(files.holdout.rows).toBe(holdout.length);
    expect(Object.keys(rows.train.skipped).sort()).toEqual(
      [
        "fallback_forecast",
        "horizon_crosses_split",
        "no_decision_input",
        "no_target",
        "safety_alert",
      ].sort(),
    );
    expect(build.manifest.dataset_skips).toMatchObject({ outside_periods: 10 });
  });
});

describe("NFR-012: re-running gives the same bytes", () => {
  it("rebuilds identical JSONL and manifest from the snapshot read back from disk text", async () => {
    const again = await buildWith(parseSnapshot(JSON.parse(serializeSnapshot(snapshot))));
    expect(again.trainJsonl).toBe(build.trainJsonl);
    expect(again.holdoutJsonl).toBe(build.holdoutJsonl);
    expect(again.manifestJson).toBe(build.manifestJson);
  });
});
