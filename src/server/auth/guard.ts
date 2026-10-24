import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Allowlist } from "./allowlist.js";
import { formatMadridTime } from "./banner.js";
import { PAIR_PAGE_HTML, PAIR_PAGE_PATHS, PAIR_PAGE_SCRIPT, PAIR_PAGE_STYLE } from "./pair-page.js";
import type { FailureLimiter, SlidingWindowLimiter } from "./rate-limit.js";
import { hashSecret } from "./secrets.js";
import { SESSION_TTL_MS, type AuthStore } from "./store.js";
import { z } from "zod";

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

/**
 * What hosted mode changes in the access control (AC-032.3, AC-032.7); absent in home mode, which
 * is then exactly what it was: the `__Host-` cookie is `Secure`, the device is remembered (the
 * session is renewed when used), pairing is a page that POSTs the token from the URL fragment,
 * and the container's health check is answered from loopback.
 */
export interface HostedGuard {
  /** Per client address; counts every pairing POST, whatever its outcome. */
  readonly pairLimiter: SlidingWindowLimiter;
}

export interface GuardDeps {
  readonly store: AuthStore;
  readonly limiter: FailureLimiter;
  readonly allowlist: Allowlist;
  readonly hosted?: HostedGuard;
  /** Console output for pairing lines (never the logger: AC-001.7). */
  readonly print: (line: string) => void;
}

/** The session of each request that passed the guard, as a hash: never the cookie value itself. */
const sessionKeys = new WeakMap<FastifyRequest, string>();

/**
 * A stable key for the session a guarded request came with (the hash of its cookie), for limits
 * that count per session. Undefined on a request without a session, such as `/pair`.
 */
export function sessionKeyOf(request: FastifyRequest): string | undefined {
  return sessionKeys.get(request);
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
const HOSTED_PAIR_HINT = "Run `sib pair` on the server and open the link it prints.";

const pairBody = z.object({ token: z.string().max(200) }).strict();

const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The container's own health check (AC-032.7): the connection itself comes from loopback and no
 * proxy set a forwarding header. The peer address is the socket's, never `X-Forwarded-For`.
 */
function isLoopbackHealthCheck(request: FastifyRequest): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.url === "/healthz" &&
    LOOPBACK_ADDRESSES.has(request.socket.remoteAddress ?? "") &&
    request.headers["x-forwarded-for"] === undefined &&
    request.headers["forwarded"] === undefined
  );
}

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
  const { store, limiter, allowlist, print, hosted } = deps;
  const now = store.now;
  const pairHint = hosted === undefined ? PAIR_HINT : HOSTED_PAIR_HINT;

  /** The cookie value of a live session, or undefined. Hosted mode takes the `__Host-` cookie only. */
  const liveSession = (request: FastifyRequest): string | undefined => {
    const candidates =
      hosted === undefined
        ? [
            ...readCookies(request.headers.cookie, SECURE_SESSION_COOKIE),
            ...readCookies(request.headers.cookie, SESSION_COOKIE),
          ]
        : readCookies(request.headers.cookie, SECURE_SESSION_COOKIE);
    const valid = candidates
      .slice(0, MAX_COOKIE_CANDIDATES)
      .find((candidate) => store.isValidSession(candidate));
    if (valid !== undefined) {
      sessionKeys.set(request, hashSecret(valid));
    }
    return valid;
  };

  /** True when the request came in through an https public origin (AC-001.10). */
  const isSecureHost = (request: FastifyRequest): boolean =>
    hosted !== undefined || allowlist.secureHosts.has(request.headers.host?.toLowerCase() ?? "");

  // The default 404 handler logs and echoes the requested URL, query string included.
  app.setNotFoundHandler((_request, reply) => problem(reply, 404, "Not Found"));

  app.addHook("onRequest", async (request, reply) => {
    reply.headers(SECURITY_HEADERS);

    // The container's health check, before the Host check: it connects to 127.0.0.1 by address.
    if (hosted !== undefined && isLoopbackHealthCheck(request)) {
      return reply.code(204).header("cache-control", "no-store").send();
    }

    const host = request.headers.host?.toLowerCase();
    if (host === undefined || !allowlist.hosts.has(host)) {
      return problem(reply, 421, "Misdirected Request");
    }

    const session = liveSession(request);
    if (session === undefined) {
      const client = request.ip;
      if (limiter.isBlocked(client)) {
        request.log.warn({ clientAddress: client }, "unauthenticated client is rate limited");
        return problem(reply, 429, "Too Many Requests", undefined, {
          "retry-after": String(limiter.retryAfterSeconds(client)),
        });
      }
      if (request.routeOptions.config?.public !== true) {
        limiter.recordFailure(client);
        return problem(reply, 401, "Unauthorized", pairHint);
      }
    } else if (hosted !== undefined) {
      // A remembered device (AC-032.3): the session and its cookie are renewed when used, once a
      // day at most, so a phone in use is never signed out.
      const renewedUntil = store.renewSession(session);
      if (renewedUntil !== undefined) {
        reply.header("set-cookie", sessionCookie(session, SESSION_TTL_MS / 1000, true));
      }
    }

    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin;
      if (origin === undefined || !allowlist.origins.has(origin)) {
        return problem(reply, 403, "Forbidden");
      }
    }
  });

  if (hosted === undefined) {
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
  } else {
    registerHostedPairing(app, deps, hosted);
  }

  // "Forget devices" from the app (AC-001.6); the session guard and Origin check already ran.
  app.post("/api/devices/forget", (request, reply) => {
    store.forgetDevices();
    return reply
      .header("set-cookie", sessionCookie("", 0, isSecureHost(request)))
      .code(204)
      .send();
  });
}

/**
 * Hosted pairing (AC-032.3): `GET /pair` is a page with a button, never a token exchange, so a link
 * preview that fetches the URL cannot spend the token. The button POSTs the token from the URL
 * fragment to `POST /pair`, which the guard has already Origin-checked. Every failure looks the
 * same (401, counted), and every POST counts against the client address, whatever its outcome.
 */
function registerHostedPairing(app: FastifyInstance, deps: GuardDeps, hosted: HostedGuard): void {
  const { store, limiter, print } = deps;
  const asset = (path: string, type: string, body: string): void => {
    app.get(path, { config: { public: true }, exposeHeadRoute: false }, (_request, reply) =>
      reply
        .header("content-type", `${type}; charset=utf-8`)
        .header("cache-control", "no-store")
        .send(body),
    );
  };
  asset(PAIR_PAGE_PATHS.page, "text/html", PAIR_PAGE_HTML);
  asset(PAIR_PAGE_PATHS.script, "text/javascript", PAIR_PAGE_SCRIPT);
  asset(PAIR_PAGE_PATHS.style, "text/css", PAIR_PAGE_STYLE);

  app.post(
    "/pair",
    {
      config: { public: true },
      bodyLimit: 1024,
      // Before the body is parsed, so a flood of broken bodies counts as well.
      onRequest: (request, reply) => {
        const wait = hosted.pairLimiter.take(request.ip);
        return Promise.resolve(
          wait > 0
            ? problem(reply, 429, "Too Many Requests", undefined, { "retry-after": String(wait) })
            : undefined,
        );
      },
    },
    (request, reply) => {
      const body = pairBody.safeParse(request.body);
      const session = body.success ? store.pair(body.data.token) : null;
      if (session === null) {
        limiter.recordFailure(request.ip);
        return problem(
          reply,
          401,
          "Unauthorized",
          `This pairing link is invalid, expired or used up. ${HOSTED_PAIR_HINT}`,
        );
      }
      print(
        `Paired a device at ${formatMadridTime(store.now())} from ${forConsole(request.ip, 64)} (user agent: ${forConsole(request.headers["user-agent"])})`,
      );
      return reply
        .header("set-cookie", sessionCookie(session.sessionId, SESSION_TTL_MS / 1000, true))
        .header("cache-control", "no-store")
        .code(204)
        .send();
    },
  );
}
