import sharp from "sharp";
import { z } from "zod";

import { DigitalOceanClient, DIGITALOCEAN_INFERENCE_URL } from "./digitalocean.js";
import { parseModeSettings, type HostedSettings } from "../mode.js";
import type { ChatRequest } from "./client.js";

/**
 * `sib hosted-check` (AC-032.8): what the builder runs once after deploying, with the env file of
 * the server. It calls the inference API once per check and says what works, so the builder knows
 * whether `SIB_TOOL_USE=native` and `SIB_DO_VISION=1` are safe. Nothing here is household data:
 * the prompts are fixed words, the image is a few synthetic pixels, and no database or data
 * folder is opened. Its calls are made by hand, outside the app, so they do not count against the
 * daily cap (`SIB_DAILY_MODEL_CALLS`): four calls, once after a deploy.
 */

export interface CheckResult {
  readonly check: string;
  readonly ok: boolean;
  /** Plain words: what was seen, or what to do instead. */
  readonly detail: string;
}

export interface HostedCheckDeps {
  readonly fetch?: typeof fetch;
}

const CALL_TIMEOUT_MS = 30_000;

const jsonAnswer = z.object({ ok: z.literal(true) });

const FORECAST_TOOL = {
  name: "get_forecast",
  description: "Returns the hourly weather forecast for the next hours.",
  parameters: {
    type: "object",
    properties: { hours_ahead: { type: "integer", minimum: 1, maximum: 48 } },
    required: ["hours_ahead"],
  },
} as const;

/** The synthetic image is solid red; a model that sees it says one of these. */
const RED_ANSWER = /red|pink|orange/i;

/** Eight by eight pixels of one colour: nothing a person could be recognised in. */
async function syntheticImage(): Promise<Uint8Array> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "failed";
}

async function attempt(
  check: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
  failed: string,
): Promise<CheckResult> {
  try {
    const { ok, detail } = await run();
    return { check, ok, detail: ok ? detail : `${detail} ${failed}`.trim() };
  } catch (error) {
    // The client's messages never hold the key or the prompt.
    return { check, ok: false, detail: `${reason(error)}. ${failed}`.trim() };
  }
}

/** Runs the four checks of AC-032.8 against the API named by `settings`. */
export async function runHostedChecks(
  settings: HostedSettings,
  deps: HostedCheckDeps = {},
): Promise<CheckResult[]> {
  const client = new DigitalOceanClient({
    model: settings.model,
    apiKey: settings.inferenceKey,
    // The check sends an image whatever `SIB_DO_VISION` says: that is what it is asking.
    vision: true,
    toolUse: "native",
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const ask = (request: Omit<ChatRequest, "job" | "timeoutMs">) =>
    client.chat({ job: "hosted-check", timeoutMs: CALL_TIMEOUT_MS, ...request });
  const results: CheckResult[] = [];

  results.push(
    await attempt(
      "model listed",
      async () => {
        const ids = await client.modelIds();
        if (ids === undefined) {
          return { ok: false, detail: "GET /v1/models did not answer with a model list." };
        }
        if (ids.includes(settings.model)) {
          return { ok: true, detail: `${settings.model} is listed.` };
        }
        const gemma = ids.filter((id) => /gemma/i.test(id));
        return {
          ok: false,
          detail: `${settings.model} is not listed.${gemma.length === 0 ? "" : ` Gemma models listed: ${gemma.join(", ")}.`}`,
        };
      },
      "Set SIB_DO_MODEL to a listed Gemma 4 ID.",
    ),
  );

  results.push(
    await attempt(
      "JSON answer",
      async () => {
        const answer = await ask({
          messages: [
            { role: "system", content: "Answer with JSON only." },
            { role: "user", content: 'Reply with the JSON object {"ok": true}.' },
          ],
          schema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(answer.content);
        } catch {
          return { ok: false, detail: "The answer was not JSON." };
        }
        return jsonAnswer.safeParse(parsed).success
          ? { ok: true, detail: "A schema-valid JSON answer came back." }
          : { ok: false, detail: "The JSON did not match the schema." };
      },
      "Jobs need valid JSON: change the model or RESPONSE_FORMAT in digitalocean-wire.ts.",
    ),
  );

  results.push(
    await attempt(
      "tool call",
      async () => {
        const answer = await ask({
          messages: [
            {
              role: "system",
              content: "You have a tool. Call it before you answer anything about the weather.",
            },
            { role: "user", content: "Will it rain in the next 6 hours?" },
          ],
          tools: [FORECAST_TOOL],
        });
        const called = answer.toolCalls.some((call) => call.name === FORECAST_TOOL.name);
        return called
          ? { ok: true, detail: "Gemma called get_forecast. SIB_TOOL_USE=native can be tried." }
          : { ok: false, detail: "No tool call came back." };
      },
      "Use injected tool use (SIB_TOOL_USE=injected, the default).",
    ),
  );

  results.push(
    await attempt(
      "image accepted",
      async () => {
        const answer = await ask({
          messages: [{ role: "user", content: "Name the main colour of this image in one word." }],
          images: [await syntheticImage()],
        });
        // Accepting the request is not enough: a model that ignores the image still answers.
        return RED_ANSWER.test(answer.content)
          ? { ok: true, detail: "The image was seen (red). SIB_DO_VISION=1 can be tried." }
          : { ok: false, detail: "The model answered without seeing the image." };
      },
      "Keep SIB_DO_VISION off.",
    ),
  );
  return results;
}

/** The result table, plain text for the terminal. */
export function formatCheckTable(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((result) => result.check.length));
  return [
    `Checked ${DIGITALOCEAN_INFERENCE_URL} (one call per check, no household data):`,
    ...results.map(
      (result) =>
        `  ${result.ok ? "PASS" : "FAIL"}  ${result.check.padEnd(width)}  ${result.detail}`,
    ),
  ].join("\n");
}

/**
 * The CLI command. It needs the server's hosted settings (`SIB_MODE=hosted`, the model, the key),
 * so it is run with the same env file. Exit code 1 when the model is not listed or JSON fails,
 * because the app cannot work then; a failing tool or image check only changes what to switch on.
 */
export async function hostedCheckCommand(
  env: NodeJS.ProcessEnv,
  print: (text: string) => void,
  deps: HostedCheckDeps = {},
): Promise<number> {
  let settings;
  try {
    settings = parseModeSettings(env);
  } catch (error) {
    print(reason(error));
    return 1;
  }
  if (settings.mode !== "hosted") {
    print(
      "sib hosted-check needs SIB_MODE=hosted and the hosted settings (use the server's env file).",
    );
    return 1;
  }
  const results = await runHostedChecks(settings, deps);
  print(formatCheckTable(results));
  const required = results.slice(0, 2).every((result) => result.ok);
  print(
    required
      ? "Record these results in docs/adr/0011-optional-hosted-mode-on-digitalocean.md."
      : "The app cannot use this model yet: fix the failing checks above.",
  );
  return required ? 0 : 1;
}
