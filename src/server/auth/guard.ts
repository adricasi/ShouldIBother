import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Allowlist } from "./allowlist.js";
import { formatMadridTime } from "./banner.js";
import type { FailureLimiter } from "./rate-limit.js";
import { SESSION_TTL_MS, type AuthStore } from "./store.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Marks the one route that is reachable without a session: `/pair`. */
    public?: boolean;
  }
}

/** Cookie name over http. Over an https public origin the `__Host-` form is used (see below). */
export const SESSION_COOKIE = "sib_session";
/** `__Host-` makes browsers insist on Secure, Path=/ and no Domain, so a sibling cannot shadow it. */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** Cookies with the same name from other apps on this host are tried one by one, up to this many. */
const MAX_COOKIE_CANDIDATES = 4;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' blob: data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export interface GuardDeps {
  readonly store: AuthStore;
  readonly limiter: FailureLimiter;
  readonly allowlist: Allowlist;
  /** Console output for pairing lines (never the logger: AC-001.7). */
  readonly print: (line: string) => void;
}

/** Values of the cookies called `name` in a Cookie header, in order. */
export function readCookies(header: string | undefined, name: string): string[] {
  if (header === undefined) {
    return [];
  }
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      values.push(part.slice(separator + 1).trim());
    }
  }
  return values;
}

function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** Terminal-safe: drops control characters (escape sequences) and caps the length. */
function forConsole(value: string | undefined, max = 200): string {
  return (value ?? "-").replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/** RFC 9457 problem details; the body never carries app data. */
function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
  headers: Record<string, string> = {},
): FastifyReply {
  return reply
    .code(status)
    .headers(headers)
    .header("content-type", "application/problem+json")
    .header("cache-control", "no-store")
    .send({ type: "about:blank", title, status, ...(detail === undefined ? {} : { detail }) });
}

/**
 * Errors Fastify raises before routing (a malformed URL) never reach the hooks. They get the
 * same headers and problem body, and do not echo the URL back (it may carry a token).
 */
export function frameworkErrorHandler(
  error: { statusCode?: number },
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  const status = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 400;
  void reply.headers(SECURITY_HEADERS);
  void problem(reply, status, "Bad Request");
}

const PAIR_HINT = "Open the pairing link printed on the laptop, or run `sib pair` there.";

/**
 * Registers the access control on the root app so it covers every route, including routes
 * added later and unknown paths (REQ-001, NFR-001). Order of checks for each request:
 *   1. security headers (also on errors);
 *   2. Host allowlist -> 421 (AC-001.9);
 *   3. no valid session: blocked client -> 429 (AC-001.5); any route but `/pair` -> 401, counted
 *      as a failure (AC-001.3);
 *   4. POST/PUT/DELETE (anything but GET/HEAD/OPTIONS) needs an app Origin -> 403 (AC-001.4).
 * A request with a valid session skips the limiter entirely.
 */
export function registerAuth(app: FastifyInstance, deps: GuardDeps): void {
  const { store, limiter, allowlist, print } = deps;
  const now = store.now;

  const hasValidSession = (request: FastifyRequest): boolean =>
    [
      ...readCookies(request.headers.cookie, SECURE_SESSION_COOKIE),
      ...readCookies(request.headers.cookie, SESSION_COOKIE),
    ]
      .slice(0, MAX_COOKIE_CANDIDATES)
      .some((candidate) => store.isValidSession(candidate));

  /** True when the request came in through an https public origin (AC-001.10). */
  const isSecureHost = (request: FastifyRequest): boolean =>
    allowlist.secureHosts.has(request.headers.host?.toLowerCase() ?? "");

  // The default 404 handler logs and echoes the requested URL, query string included.
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, "Not Found"));

  app.addHook("onRequest", async (request, reply) => {
    reply.headers(SECURITY_HEADERS);

    const host = request.headers.host?.toLowerCase();
    if (host === undefined || !allowlist.hosts.has(host)) {
      return problem(reply, 421, "Misdirected Request");
    }

    if (!hasValidSession(request)) {
      const client = request.ip;
      if (limiter.isBlocked(client)) {
        request.log.warn({ clientAddress: client }, "unauthenticated client is rate limited");
        return problem(reply, 429, "Too Many Requests", undefined, {
          "retry-after": String(limiter.retryAfterSeconds(client)),
        });
      }
      if (request.routeOptions.config?.public !== true) {
        limiter.recordFailure(client);
        return problem(reply, 401, "Unauthorized", PAIR_HINT);
      }
    }

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin === undefined || !allowlist.origins.has(origin)) {
        return problem(reply, 403, "Forbidden");
      }
    }
  });

  // The pairing exchange (AC-001.2). Every failure looks the same: 401 and a counted failure.
  // No HEAD twin: a HEAD request must not use up a device slot or set a cookie.
  app.get("/pair", { config: { public: true }, exposeHeadRoute: false }, (request, reply) => {
    const { token } = request.query as { token?: unknown };
    const session = typeof token === "string" ? store.pair(token) : null;
    if (session === null) {
      limiter.recordFailure(request.ip);
      return problem(
        reply,
        401,
        "Unauthorized",
        `This pairing link is invalid, expired or used up. ${PAIR_HINT}`,
      );
    }
    const secure = isSecureHost(request);
    print(
      `Paired a device at ${formatMadridTime(now())} from ${forConsole(request.ip, 64)} (user agent: ${forConsole(request.headers["user-agent"])})`,
    );
    return reply
      .header("set-cookie", sessionCookie(session.sessionId, SESSION_TTL_MS / 1000, secure))
      .header("cache-control", "no-store")
      .redirect("/", 303);
  });

  // "Forget devices" from the app (AC-001.6); the session guard and Origin check already ran.
  app.post("/api/devices/forget", (request, reply) => {
    store.forgetDevices();
    return reply
      .header("set-cookie", sessionCookie("", 0, isSecureHost(request)))
      .code(204)
      .send();
  });
}
