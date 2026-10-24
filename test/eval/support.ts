import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { ruleAdvice, type AdviceChore } from "../../src/domain/advice.js";
import { HOUR_MS } from "../../src/domain/time.js";
import type { ForecastHour } from "../../src/domain/weather.js";
import { loadAdviceRules } from "../../src/server/advice-rules.js";
import type { EvalDeps } from "../../src/eval/command.js";
import { evalCommand } from "../../src/eval/command.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelClient,
  ModelHealth,
  ModelState,
} from "../../src/server/model/client.js";
import { syntheticPhoto } from "../support/photos.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A temporary folder outside any git working tree, removed after the test. */
export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "sib-eval-"));
  directories.push(directory);
  return directory;
}

/** The data block of the user message: the JSON between the untrusted-data delimiters. */
function dataOf(request: ChatRequest): Record<string, unknown> {
  const text = request.messages.find((message) => message.role === "user")?.content ?? "";
  const match = /<untrusted_data>\n([\s\S]*)\n<\/untrusted_data>/.exec(text);
  return match?.[1] === undefined ? {} : (JSON.parse(match[1]) as Record<string, unknown>);
}

/** The forecast rows the advisor read, from the tool result message of the request. */
function advisorAnswer(request: ChatRequest): unknown {
  const text = request.messages.find((message) => message.role === "tool")?.content ?? "";
  const match = /<untrusted_data>\n([\s\S]*)\n<\/untrusted_data>/.exec(text);
  const rows = (
    JSON.parse(match?.[1] ?? '{"hours":[]}') as { hours: Record<string, number | null>[] }
  ).hours;
  const hours: ForecastHour[] = rows.map((row, index) => ({
    startsAt: index * HOUR_MS,
    precipitationMm: row["precip_mm"] ?? null,
    precipitationProbabilityPct: row["precip_prob_pct"] ?? null,
    temperatureC: row["temp_c"] ?? null,
    dewPointC: row["dew_point_c"] ?? null,
    relativeHumidityPct: row["humidity_pct"] ?? null,
    windKmh: row["wind_kmh"] ?? null,
    gustKmh: row["gust_kmh"] ?? null,
    sunshineSeconds: null,
    weatherCode: row["weather_code"] ?? null,
    isDay: null,
  }));
  const user = request.messages.find((message) => message.role === "user")?.content ?? "";
  const chore = (/"chore_type":"([a-z_]+)"/.exec(user)?.[1] ?? "windows_clean") as AdviceChore;
  const advice = ruleAdvice(chore, hours, loadAdviceRules());
  return {
    status: "ok",
    advice: advice.advice,
    ...(advice.window === undefined
      ? {}
      : {
          window: {
            start_hours_ahead: advice.window.startHoursAhead,
            end_hours_ahead: advice.window.endHoursAhead,
          },
        }),
    reason: "Echoing the rule advice.",
  };
}

const BANDS = ["very_unlikely", "unlikely", "toss_up", "likely", "very_likely"] as const;

/**
 * A fake Gemma that answers every job of every committed case set correctly, by reading the data
 * block it is given: the bookmaker calls `get_forecast` and repeats the rule band, the planner
 * scores the days with the rule bands, the judge picks a verdict by the kind of bet. It lets the
 * tests run the real case files end to end; it is not a fixture of any job.
 */
export class EchoModel implements ModelClient {
  readonly requests: ChatRequest[] = [];
  private state: ModelState = "online";
  /**
   * Makes a call fail or answer badly: return the reply to send instead, the word "timeout" or
   * "unavailable" for a runtime failure, or undefined to answer normally.
   */
  tamper: ((request: ChatRequest, data: Record<string, unknown>) => string | undefined) | undefined;
  /** Waits this long before each answer, to test the photo budget with a real clock. */
  delayMs = 0;

  setHealth(state: ModelState): void {
    this.state = state;
  }

  health(): Promise<ModelHealth> {
    return Promise.resolve({ state: this.state, detail: "echo model" });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const data = dataOf(request);
    const tampered = this.tamper?.(request, data);
    if (tampered === "timeout" || tampered === "unavailable") {
      const { ModelTimeoutError, ModelUnavailableError } =
        await import("../../src/server/model/client.js");
      throw tampered === "timeout"
        ? new ModelTimeoutError("echo: timeout")
        : new ModelUnavailableError("echo: unavailable");
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const base = { model: "echo-gemma", modelDigest: "sha256:echo" };
    if (tampered !== undefined) {
      return { ...base, content: tampered, toolCalls: [] };
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      return {
        ...base,
        content: "",
        toolCalls: [
          {
            name: "get_forecast",
            // The advisor looks as far as its tool allows; the other jobs ask for a day.
            arguments: { hours_ahead: request.job === "advisor" ? 72 : 24 },
          },
        ],
      };
    }
    return { ...base, content: JSON.stringify(this.answer(request, data)), toolCalls: [] };
  }

  private answer(request: ChatRequest, data: Record<string, unknown>): unknown {
    switch (request.job) {
      case "listener":
        return { chores: [{ label: "water the plants", chore_type: "plants" }] };
      case "bookmaker": {
        const [earliest] = data["settle_in_hours_between"] as number[];
        return {
          status: "ok",
          band: data["rule_band"],
          reason: "Echoing the rule band.",
          settle_in_hours: earliest ?? 12,
        };
      }
      case "inspector":
        return { status: "ok", observations: [{ name: "item", value: "pots" }] };
      case "judge":
        return {
          status: "ok",
          verdict: data["bet"] === "do_it" ? "weather_would_have" : "win",
          reason: "Echoing a verdict.",
          evidence: [],
        };
      case "safety":
        return { status: "ok", alert: false };
      case "laundry-planner": {
        const days = data["days"] as { key: string; rule_band: string | null }[];
        const scores = days.map((day) => ({
          day: day.key,
          score: day.rule_band ?? "very_unlikely",
        }));
        const ordinal = (score: string): number => BANDS.indexOf(score as (typeof BANDS)[number]);
        const best = Math.max(...scores.map((entry) => ordinal(entry.score)));
        const bestEntry = scores.find((entry) => ordinal(entry.score) === best)!;
        const today = ordinal(scores[0]!.score);
        if (best < 2) {
          return { status: "ok", state: "no_good_day", days: scores, reason: "No day dries well." };
        }
        return today === best
          ? {
              status: "ok",
              state: "wash_today",
              best_day: "day_0",
              days: scores,
              reason: "Today is best.",
            }
          : {
              status: "ok",
              state: "skip_today",
              best_day: bestEntry.day,
              days: scores,
              reason: "Wait.",
            };
      }
      case "advisor":
        return advisorAnswer(request);
      default:
        throw new Error(`EchoModel does not know the job ${request.job}`);
    }
  }
}

/** Runs the command and collects what it prints. */
export async function runEvalCli(
  args: readonly string[],
  deps: EvalDeps,
): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const code = await evalCommand(
    args,
    (text) => {
      lines.push(text);
    },
    deps,
  );
  return { code, output: lines.join("\n") };
}

/** Dependencies that run the command on `model` with a fixed clock and a private data folder. */
export function depsFor(model: ModelClient, extra: Partial<EvalDeps> = {}): EvalDeps {
  const data = tempDir();
  return {
    env: { SIB_DATA_DIR: data },
    now: () => Date.UTC(2026, 9, 23, 12, 0, 0),
    createModel: () => Promise.resolve({ model, mode: "ollama" as const }),
    ...extra,
  };
}

/** A folder with a synthetic JPEG for each name, standing in for the builder's staged photos. */
export async function stagedPhotos(names: readonly string[]): Promise<string> {
  const directory = tempDir();
  const image = await syntheticPhoto({ width: 320, height: 240 });
  for (const name of names) {
    writeFileSync(join(directory, name), image);
  }
  return directory;
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
