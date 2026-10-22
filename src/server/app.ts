import type { Writable } from "node:stream";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";

import type { Allowlist } from "./auth/allowlist.js";
import { frameworkErrorHandler, registerAuth } from "./auth/guard.js";
import { FailureLimiter } from "./auth/rate-limit.js";
import type { AuthStore } from "./auth/store.js";
import type { Core } from "./core.js";
import { FLAG_NAMES, type FlagName, type Flags } from "./flags.js";

/** Route plugins of the flagged features, keyed by their flag. */
export type FeaturePlugins = Readonly<Partial<Record<FlagName, FastifyPluginAsync>>>;

/** Everything the access control needs (REQ-001); required, so no app is built without it. */
export interface AuthOptions {
  readonly store: AuthStore;
  readonly allowlist: Allowlist;
  /** Console output for pairing lines; defaults to stderr, keeping stdout for the JSON logs. */
  readonly print?: (line: string) => void;
}

export interface AppOptions {
  readonly auth: AuthOptions;
  readonly flags: Flags;
  readonly features?: FeaturePlugins;
  /** The core loop (cards, bets, settlement). Omitted by tests that only exercise the access control. */
  readonly core?: Core;
  /** Folder with the built SPA (`dist/web`); when set, its files are served behind the same guard. */
  readonly webRoot?: string;
  readonly logger?: boolean;
  /** Log destination; defaults to stdout. Used by tests to capture log lines. */
  readonly logStream?: Writable;
}

/** Credentials never reach the logs (NFR-001, AC-001.7). */
export const LOG_REDACT_PATHS: string[] = [
  "req.headers.cookie",
  "req.headers.authorization",
  'res.headers["set-cookie"]',
];

/** The query string is dropped from logged URLs: `/pair?token=...` carries the pairing token. */
export function redactUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?[redacted]`;
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  socket?: { remotePort?: number | undefined } | undefined;
}

/** Replaces Fastify's default `req` serializer, which logs the raw URL. */
export function serializeRequest(request: LoggedRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactUrl(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** pino options shared by the app logger and its test. */
export const LOGGER_OPTIONS = {
  redact: { paths: LOG_REDACT_PATHS, censor: "[redacted]" },
  serializers: { req: serializeRequest },
};

/**
 * Builds the Fastify app. A feature's plugin is registered only when its flag is on
 * (REQ-029, AC-029.2): with the flag off the feature exposes no route at all, so a request
 * for it gets a plain 404. The access control (pairing, sessions, Host and Origin checks) is
 * registered first and covers every route, `/healthz` included, except `/pair`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const now = options.auth.store.now;
  const app = Fastify({
    frameworkErrors: frameworkErrorHandler,
    logger: options.logger
      ? {
          ...LOGGER_OPTIONS,
          ...(options.logStream ? { stream: options.logStream } : {}),
        }
      : false,
  });
  registerAuth(app, {
    store: options.auth.store,
    limiter: new FailureLimiter(now),
    allowlist: options.auth.allowlist,
    print: options.auth.print ?? ((line) => console.error(line)),
  });
  app.get("/healthz", () => ({ status: "ok" }));

  if (options.core !== undefined) {
    const { core } = options;
    await app.register(core.plugin);
    app.addHook("onClose", () => {
      core.scheduler.stop();
    });
  }

  for (const flag of FLAG_NAMES) {
    const plugin = options.features?.[flag];
    if (plugin !== undefined && options.flags[flag]) {
      await app.register(plugin);
    }
  }

  if (options.webRoot !== undefined) {
    // Registered last and without a wildcard: only files that exist at start-up get a route.
    await app.register(fastifyStatic, { root: options.webRoot, wildcard: false });
  }
  return app;
}
