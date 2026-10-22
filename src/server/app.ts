import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";

import type { FlagName, Flags } from "./flags.js";

/** Route plugins of the flagged features, keyed by their flag. */
export type FeaturePlugins = Readonly<Partial<Record<FlagName, FastifyPluginAsync>>>;

export interface AppOptions {
  readonly flags: Flags;
  readonly features?: FeaturePlugins;
  readonly logger?: boolean;
}

/**
 * Builds the Fastify app. A feature's plugin is registered only when its flag is on
 * (REQ-029, AC-029.2): with the flag off the feature exposes no route at all, so a request
 * for it gets a plain 404. Later tasks add pairing, the API and the SPA on top of this.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  app.get("/healthz", () => ({ status: "ok" }));

  for (const [flag, plugin] of Object.entries(options.features ?? {}) as [
    FlagName,
    FastifyPluginAsync,
  ][]) {
    if (options.flags[flag]) {
      await app.register(plugin);
    }
  }
  return app;
}
