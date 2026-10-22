import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";

/** Default app port (design.md, A-13). `port` in config/server.json, then SIB_PORT, override it. */
export const DEFAULT_PORT = 8787;

export const CONFIG_DIR = fileURLToPath(new URL("../../config/", import.meta.url));

/** Read and parse a JSON config file; failures name the file instead of leaking a bare errno. */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Cannot read config file ${path}: ${String(error)}`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${path}: ${String(error)}`, { cause: error });
  }
}

/** What the household has outside the door (onboarding, AC-024.1). */
export const OUTDOOR_ITEMS = ["balcony_plants", "clothes_line"] as const;
export type OutdoorItem = (typeof OUTDOOR_ITEMS)[number];

/** The household baseline behind the savings figures (A-6). */
export const householdSchema = z.object({
  airConditioning: z.boolean(),
  heaterThisSeason: z.boolean(),
  dryer: z.enum(["heat-pump", "condenser", "vented", "none"]),
  /**
   * Neighbourhood-level coordinates for the forecast; rounded to 2 decimals before every request
   * (AC-014.1). Absent: Gràcia, Barcelona (product.md, Constraints).
   */
  location: z
    .object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })
    .strict()
    .optional(),
  /** Asked in onboarding (AC-024.1); absent in the config file, which does not need it. */
  outdoorItems: z
    .array(z.enum(OUTDOOR_ITEMS))
    .max(OUTDOOR_ITEMS.length)
    .refine((items) => new Set(items).size === items.length, "each item once")
    .optional(),
});
export type Household = z.infer<typeof householdSchema>;

/** Where the household is when the config does not say: Gràcia, Barcelona (product.md). */
export const DEFAULT_LOCATION = { latitude: 41.4, longitude: 2.16 } as const;

/**
 * `config/household.json` holds the real household values and is git-ignored (NFR-002); the
 * committed `household.example.json` is the fallback so a fresh clone still starts.
 */
export function loadHousehold(configDir: string = CONFIG_DIR): Household {
  const real = `${configDir}household.json`;
  const path = existsSync(real) ? real : `${configDir}household.example.json`;
  const result = householdSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid household config ${path}: ${result.error.message}`);
  }
  return result.data;
}

/** A `config.publicOrigins` entry: an http(s) origin with no credentials, path, query or fragment. */
const originSchema = z.string().transform((value, ctx) => {
  try {
    const url = new URL(value);
    const bare = url.pathname === "/" && url.search === "" && url.hash === "";
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      bare
    ) {
      return url.origin;
    }
  } catch {
    // reported below
  }
  ctx.addIssue({ code: "custom", message: `not an http(s) origin: ${JSON.stringify(value)}` });
  return z.NEVER;
});

/** A `config.allowedHosts` entry: `host` or `host:port`; no scheme, path or whitespace. */
const hostSchema = z.string().regex(/^[A-Za-z0-9.\-:[\]]+$/, "expected host or host:port");

const serverConfigSchema = z
  .object({
    /** Port of the app; `SIB_PORT` overrides it. Server and `sib pair` read the same value. */
    port: z.number().int().min(1).max(65535).default(DEFAULT_PORT),
    /** HTTPS (or other) origins that reach this app, e.g. a Tailscale Serve URL. */
    publicOrigins: z.array(originSchema).default([]),
    /** Extra Host values to accept, e.g. the Windows LAN IP behind a netsh portproxy. */
    allowedHosts: z.array(hostSchema).default([]),
  })
  .strict();
export type ServerConfig = z.infer<typeof serverConfigSchema>;

/**
 * `config/server.json` (git-ignored: it names the machine) overrides the committed
 * `server.example.json`, which has no public origins and no extra hosts.
 */
export function loadServerConfig(configDir: string = CONFIG_DIR): ServerConfig {
  const real = `${configDir}server.json`;
  const path = existsSync(real) ? real : `${configDir}server.example.json`;
  const result = serverConfigSchema.safeParse(readJsonFile(path));
  if (!result.success) {
    throw new Error(`Invalid server config ${path}: ${result.error.message}`);
  }
  return result.data;
}
