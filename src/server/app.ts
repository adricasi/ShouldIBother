import type { Writable } from "node:stream";

import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";

import { FLAG_NAMES, type FlagName, type Flags } from "./flags.js";

/** Route plugins of the flagged features, keyed by their flag. */
export type FeaturePlugins = Readonly<Partial<Record<FlagName, FastifyPluginAsync>>>;

export interface AppOptions {
  readonly flags: Flags;
  readonly features?: FeaturePlugins;
  readonly logger?: boolean;
  /** Log destination; defaults to stdout. Used by tests to capture log lines. */
  readonly logStream?: Writable;
}

/** Credentials never reach the logs (NFR-001). T-003 adds the /pair query token. */
export const LOG_REDACT_PATHS: string[] = ["req.headers.cookie", "req.headers.authorization"];

/** pino options shared by the app logger and its test. */
export const LOGGER_OPTIONS = {
  redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
};

/**
 * Builds the Fastify app. A feature's plugin is registered only when its flag is on
 * (REQ-029, AC-029.2): with the flag off the feature exposes no route at all, so a request
 * for it gets a plain 404. Later tasks add pairing, the API and the SPA on top of this.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          ...LOGGER_OPTIONS,
          ...(options.logStream ? { stream: options.logStream } : {}),
        }
      : false,
  });
  app.get("/healthz", () => ({ status: "ok" }));

  for (const flag of FLAG_NAMES) {
    const plugin = options.features?.[flag];
    if (plugin !== undefined && options.flags[flag]) {
      await app.register(plugin);
    }
  }
  return app;
}
