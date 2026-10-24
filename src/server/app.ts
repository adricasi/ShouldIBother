import { realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Writable } from "node:stream";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";

import type { Allowlist } from "./auth/allowlist.js";
import { frameworkErrorHandler, registerAuth } from "./auth/guard.js";
import { FailureLimiter, SlidingWindowLimiter } from "./auth/rate-limit.js";
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

/**
 * Hosted mode (REQ-032): the app sits behind the Caddy reverse proxy. Absent in home mode, whose
 * app is then built exactly as before.
 */
export interface HostedAppOptions {
  /** Pairing POSTs allowed per client address and minute (AC-032.3). */
  readonly pairAttemptsPerMinute?: number;
}

/** Named ranges of proxy-addr: loopback, link-local and private (RFC 1918, fc00::/7) addresses. */
export const TRUSTED_PROXY_RANGES: readonly string[] = ["loopback", "linklocal", "uniquelocal"];
/** Pairing attempts per client address and minute in hosted mode. */
export const PAIR_ATTEMPTS_PER_MINUTE = 10;

export interface AppOptions {
  readonly auth: AuthOptions;
  readonly hosted?: HostedAppOptions;
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

/** True when `pathname` (a URL path under the web root) resolves, links followed, inside it. */
export function isInsideRoot(realRoot: string, pathname: string): boolean {
  try {
    const target = realpathSync(join(realRoot, decodeURIComponent(pathname)));
    return target === realRoot || target.startsWith(`${realRoot}${sep}`);
  } catch {
    return false;
  }
}

/** Built assets carry a content hash in their name (`/assets/index-<hash>.js`), the page does not. */
export function staticCacheControl(root: string, path: string): string {
  const inAssets = relative(root, path).split(sep)[0] === "assets";
  return inAssets ? "private, max-age=31536000, immutable" : "private, no-cache";
}

/**
 * Builds the Fastify app. A feature's plugin is registered only when its flag is on
 * (REQ-029, AC-029.2): with the flag off the feature exposes no route at all, so a request
 * for it gets a plain 404. The access control (pairing, sessions, Host and Origin checks) is
 * registered first and covers every route, `/healthz` included, except `/pair`.
 */
export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const now = options.auth.store.now;
  const app = Fastify({
    // Behind Caddy the peer is the proxy; `request.ip` (and so every rate limit) must be the client
    // address the proxy reports in `X-Forwarded-For`. Forwarded headers are believed only from
    // loopback and private addresses (the Compose network), never from the internet (AC-032.3).
    ...(options.hosted === undefined ? {} : { trustProxy: [...TRUSTED_PROXY_RANGES] }),
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
    ...(options.hosted === undefined
      ? {}
      : {
          hosted: {
            pairLimiter: new SlidingWindowLimiter(
              now,
              options.hosted.pairAttemptsPerMinute ?? PAIR_ATTEMPTS_PER_MINUTE,
            ),
          },
        }),
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
    const root = options.webRoot;
    const realRoot = realpathSync(root);
    await app.register(fastifyStatic, {
      root,
      wildcard: false,
      // The files are behind the session guard, so a shared cache must never keep them.
      dotfiles: "ignore",
      // A symlink in the web root that points elsewhere must not leak the file it points to.
      allowedPath: (pathname) => isInsideRoot(realRoot, pathname),
      cacheControl: false,
      setHeaders: (response, path) => {
        void response.header("cache-control", staticCacheControl(root, path));
      },
    });
  }
  return app;
}
