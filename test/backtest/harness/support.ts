import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { reportBaseName } from "../../../src/backtest/harness/index.js";
import type { StrategyId } from "../../../src/backtest/harness/index.js";

import { writeSnapshot, type WeatherSnapshot } from "../../../src/backtest/index.js";
import { syntheticSnapshot } from "../support/synthetic-weather.js";
import { CONFIG_DIR } from "../../../src/server/config.js";
import { loadRules } from "../../../src/server/rules.js";
import { loadSavings } from "../../../src/server/savings.js";

export const RULES = loadRules();
export const CATALOGUE = loadSavings();

/** A two-week synthetic slice that crosses 1 Sep: the last days of the training period and the hold-out. */
export function sliceSnapshot(
  options: Parameters<typeof syntheticSnapshot>[0] = {},
): Promise<WeatherSnapshot> {
  return syntheticSnapshot({
    startDate: "2026-08-24",
    requestedEndDate: "2026-09-06",
    ...options,
  });
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "sib-backtest-"));
  directories.push(directory);
  return directory;
}

/** Writes the snapshot where `sib backtest --snapshot` reads it. */
export async function snapshotOnDisk(snapshot: WeatherSnapshot): Promise<string> {
  return writeSnapshot(tempDir(), snapshot);
}

export const FOUR: readonly StrategyId[] = ["rule", "fixed", "e2b", "e4b"];

/** Where a run wrote its report, named after the strategies and splits it covered. */
export function reportFile(
  directory: string,
  extension: "md" | "json",
  ids: readonly StrategyId[] = FOUR,
  splits: "all" | "train" | "holdout" = "all",
): string {
  return join(directory, `${reportBaseName(ids, splits)}.${extension}`);
}

/** A config directory like `config/` but with the Ollama tags the test needs. */
export function configDirWith(models: Record<string, { tag: string; digest?: string }>): string {
  const directory = tempDir();
  for (const name of ["rules.json", "savings.json"]) {
    copyFileSync(join(CONFIG_DIR, name), join(directory, name));
  }
  writeFileSync(
    join(directory, "models.json"),
    JSON.stringify({ primary: "e4b", ollama: { keepAlive: "24h" }, models }),
  );
  return directory;
}

export interface OllamaRequest {
  readonly method: string;
  readonly path: string;
  readonly body: {
    model?: string;
    messages?: { role: string }[];
    keep_alive?: string | number;
    options?: { seed?: number; temperature?: number };
  } | null;
}

/**
 * A fake Ollama behind `fetch`: it lists the model, answers loads and unloads with `{}`, and for a
 * bookmaker chat first calls the tool and then answers "toss_up". `online` can be switched off.
 */
export function fakeOllama(): {
  fetch: typeof fetch;
  requests: OllamaRequest[];
  setOnline(online: boolean): void;
} {
  const requests: OllamaRequest[] = [];
  let online = true;
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetchFake: typeof fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as OllamaRequest["body"]) : null;
    requests.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (!online) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    if (url.pathname === "/api/tags") {
      return Promise.resolve(
        json({ models: [{ name: "gemma4:e4b", model: "gemma4:e4b", digest: "sha256:aaa" }] }),
      );
    }
    const messages = body?.messages ?? [];
    if (messages.length === 0) {
      return Promise.resolve(
        json({ model: "gemma4:e4b", message: { role: "assistant", content: "" } }),
      );
    }
    if (messages.at(-1)?.role === "tool") {
      return Promise.resolve(
        json({
          model: "gemma4:e4b",
          message: {
            role: "assistant",
            content: JSON.stringify({
              status: "ok",
              band: "toss_up",
              reason: "Mixed forecast.",
              settle_in_hours: 14,
            }),
          },
        }),
      );
    }
    return Promise.resolve(
      json({
        model: "gemma4:e4b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_forecast", arguments: { hours_ahead: 24 } } }],
        },
      }),
    );
  };
  return {
    fetch: fetchFake,
    requests,
    setOnline(value) {
      online = value;
    },
  };
}
