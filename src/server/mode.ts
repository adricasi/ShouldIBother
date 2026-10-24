import { isIP } from "node:net";
import { inspect } from "node:util";

import { z } from "zod";

/**
 * Home or hosted mode (REQ-032). Home is the default and is what the app has always been; hosted
 * is the optional single-household server on a DigitalOcean Droplet. Everything that differs by
 * mode is read from the settings below, parsed once at start-up.
 */

/** Calls per Madrid day to DigitalOcean's inference API when `SIB_DAILY_MODEL_CALLS` is unset. */
export const DEFAULT_DAILY_MODEL_CALLS = 300;
/** Inside the container the app listens on every interface; the port is not published on the host. */
export const DEFAULT_HOSTED_BIND_ADDRESS = "0.0.0.0";

/**
 * How the `get_forecast` tool reaches Gemma (design.md, Gemma jobs): the same values as
 * `gemma.toolUse` in `config/models.json`, which `SIB_TOOL_USE` overrides in hosted mode.
 */
export type ToolUse = "injected" | "native";

/**
 * A value that must never be printed: the inference key. It is read from the environment once and
 * handed to the one client that needs it; logging it, serialising it or inspecting it shows
 * `[redacted]` (AC-032.2).
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The secret itself; called only where it goes into a request header. */
  reveal(): string {
    return this.#value;
  }

  /** `text` with every occurrence of the secret replaced, for error messages. */
  redact(text: string): string {
    return this.#value === "" ? text : text.split(this.#value).join("[redacted]");
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [inspect.custom](): string {
    return "[redacted]";
  }
}

export interface HomeSettings {
  readonly mode: "home";
}

export interface HostedSettings {
  readonly mode: "hosted";
  /** `https://sib.example.com`: where the phone reaches the app (an origin, no trailing slash). */
  readonly publicOrigin: string;
  /** Host (with the port, if any) of the public origin, lower case, as it appears in `Host`. */
  readonly publicHost: string;
  /** The model ID DigitalOcean serves Gemma under; no default, the builder reads it from `/v1/models`. */
  readonly model: string;
  readonly inferenceKey: Secret;
  /** Photos are sent to the model only when this is true (`SIB_DO_VISION=1`, AC-032.4). */
  readonly vision: boolean;
  readonly toolUse: ToolUse;
  readonly dailyModelCalls: number;
  readonly bindAddress: string;
}

export type ModeSettings = HomeSettings | HostedSettings;

export const HOME_SETTINGS: HomeSettings = { mode: "home" };

/** Hosted mode was asked for and a setting is missing or wrong; the message names each variable. */
export class HostedSettingsError extends Error {
  override readonly name = "HostedSettingsError";
}

type Env = Readonly<Record<string, string | undefined>>;

/** An unset variable and an empty one (`SIB_DO_VISION=` in an env file) both mean "not given". */
function given(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

const modeSchema = z.enum(["home", "hosted"], {
  error: () => "must be home or hosted",
});

/** An https origin with no credentials, path, query or fragment; the port, if any, is kept. */
const publicOriginSchema = z
  .string({ error: () => "is required in hosted mode, e.g. https://sib.example.com" })
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      const bare = url.pathname === "/" && url.search === "" && url.hash === "";
      if (url.protocol === "https:" && url.username === "" && url.password === "" && bare) {
        return { origin: url.origin, host: url.host.toLowerCase() };
      }
    } catch {
      // reported below
    }
    // The value is not echoed: it could carry credentials.
    ctx.addIssue({
      code: "custom",
      message:
        "must be an https:// origin only (scheme, host and optional port; no credentials, path or query), e.g. https://sib.example.com",
    });
    return z.NEVER;
  });

/** A Gemma 4 model ID as ADR-0011 lists them (`gemma-4-31B-it`): hosted mode runs Gemma 4 only. */
export const GEMMA_4_MODEL_ID = /^gemma-4[A-Za-z0-9._:/-]{0,195}$/i;

const modelSchema = z
  .string({ error: () => "is required in hosted mode (a Gemma 4 model ID, e.g. gemma-4-31B-it)" })
  .regex(GEMMA_4_MODEL_ID, {
    error: () => "must be a Gemma 4 model ID such as gemma-4-31B-it (see ADR-0011)",
  });

const keySchema = z
  .string({
    error: () =>
      "is required in hosted mode (DigitalOcean's inference key, from the environment only)",
  })
  .regex(/^[\x21-\x7e]{8,512}$/, {
    // The value is never echoed.
    error: () => "must be 8 to 512 printable characters without spaces",
  })
  .transform((value) => new Secret(value));

const visionSchema = z
  .enum(["0", "1"], { error: () => "must be 0 or 1" })
  .default("0")
  .transform((value) => value === "1");

const toolUseSchema = z
  .enum(["injected", "native"], { error: () => "must be injected or native" })
  .default("injected");

const dailyCallsSchema = z
  .string({ error: () => "must be a positive whole number" })
  .regex(/^\d{1,7}$/, { error: () => "must be a positive whole number" })
  .transform(Number)
  .refine((value) => value >= 1, { error: () => "must be a positive whole number" })
  .default(DEFAULT_DAILY_MODEL_CALLS);

const bindAddressSchema = z
  .string({ error: () => "must be an IP address" })
  .refine((value) => isIP(value) !== 0, { error: () => "must be an IPv4 or IPv6 address" })
  .default(DEFAULT_HOSTED_BIND_ADDRESS);

const hostedEnvSchema = z.object({
  SIB_PUBLIC_ORIGIN: publicOriginSchema,
  SIB_DO_MODEL: modelSchema,
  SIB_DO_INFERENCE_KEY: keySchema,
  SIB_DO_VISION: visionSchema,
  SIB_TOOL_USE: toolUseSchema,
  SIB_DAILY_MODEL_CALLS: dailyCallsSchema,
  SIB_BIND_ADDRESS: bindAddressSchema,
});

const HOSTED_VARIABLES = Object.keys(hostedEnvSchema.shape);

/**
 * The hosted variables set in the environment. In home mode they are ignored, with one warning
 * that names them (AC-032.1); the values are never read into the message.
 */
export function ignoredHostedVariables(env: Env): string[] {
  return HOSTED_VARIABLES.filter((name) => given(env, name) !== undefined);
}

/**
 * `SIB_MODE` and, in hosted mode, the hosted settings. Called once at start-up (`loadRuntime`).
 * Home mode (the default) ignores every hosted variable, even a wrong one. Hosted mode throws a
 * `HostedSettingsError` that lists every missing or invalid variable and never prints a value.
 */
export function parseModeSettings(env: Env): ModeSettings {
  const rawMode = given(env, "SIB_MODE");
  const mode = modeSchema.safeParse(rawMode ?? "home");
  if (!mode.success) {
    throw new HostedSettingsError(
      `SIB_MODE ${mode.error.issues[0]?.message ?? "must be home or hosted"}.`,
    );
  }
  if (mode.data === "home") {
    return HOME_SETTINGS;
  }
  const result = hostedEnvSchema.safeParse(
    Object.fromEntries(HOSTED_VARIABLES.map((name) => [name, given(env, name)])),
  );
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${String(issue.path[0] ?? "settings")} ${issue.message}`,
    );
    throw new HostedSettingsError(
      `Hosted mode (SIB_MODE=hosted) cannot start:\n- ${problems.join("\n- ")}`,
    );
  }
  const settings = result.data;
  return {
    mode: "hosted",
    publicOrigin: settings.SIB_PUBLIC_ORIGIN.origin,
    publicHost: settings.SIB_PUBLIC_ORIGIN.host,
    model: settings.SIB_DO_MODEL,
    inferenceKey: settings.SIB_DO_INFERENCE_KEY,
    vision: settings.SIB_DO_VISION,
    toolUse: settings.SIB_TOOL_USE,
    dailyModelCalls: settings.SIB_DAILY_MODEL_CALLS,
    bindAddress: settings.SIB_BIND_ADDRESS,
  };
}
