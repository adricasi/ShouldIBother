/**
 * Node 24 can send `fetch` through a proxy: with `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`) it
 * reads `HTTP_PROXY`/`HTTPS_PROXY` and only skips hosts listed in `NO_PROXY`. A model runtime on
 * 127.0.0.1 must never be reached through a proxy: the prompts, photos and voice notes would leave
 * the laptop (AC-027.2, NFR-002). This is the check, pure so it can be tested.
 */

/** What `NO_PROXY` must name for 127.0.0.1, localhost and ::1 to bypass a proxy. */
export const LOOPBACK_NO_PROXY = "127.0.0.1,localhost,::1";

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "::1"] as const;

type Env = Readonly<Record<string, string | undefined>>;

const FALSY = new Set(["", "0", "false", "no", "off"]);

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && !FALSY.has(value.trim().toLowerCase());
}

function pick(env: Env, name: string): string | undefined {
  return env[name.toUpperCase()] ?? env[name.toLowerCase()];
}

/** A `NO_PROXY` entry as a bare host: no brackets, port or leading `*.` or dot. */
function entryHost(entry: string): string {
  const trimmed = entry.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(trimmed);
  if (bracketed?.[1] !== undefined) {
    return bracketed[1];
  }
  const withPort = /^([^:]+):\d+$/.exec(trimmed);
  return (withPort?.[1] ?? trimmed).replace(/^\*?\./, "");
}

function bypasses(noProxy: string, name: string): boolean {
  return noProxy.split(/[,\s]+/).some((entry) => {
    const host = entryHost(entry);
    return host === "*" || host === name;
  });
}

/**
 * Why a loopback client must not start in this environment, or undefined when it is safe: the
 * environment proxy is switched on, a proxy is configured, and `NO_PROXY` does not cover all of
 * 127.0.0.1, localhost and ::1.
 */
export function proxyBypassProblem(env: Env): string | undefined {
  const switchedOn =
    isTruthy(env["NODE_USE_ENV_PROXY"]) || (env["NODE_OPTIONS"] ?? "").includes("--use-env-proxy");
  if (!switchedOn) {
    return undefined;
  }
  const proxied = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"].some((name) => {
    const value = pick(env, name);
    return value !== undefined && value.trim() !== "";
  });
  if (!proxied) {
    return undefined;
  }
  const noProxy = pick(env, "NO_PROXY") ?? "";
  const uncovered = LOOPBACK_NAMES.filter((name) => !bypasses(noProxy, name));
  if (uncovered.length === 0) {
    return undefined;
  }
  return (
    `NODE_USE_ENV_PROXY is on with a proxy set, and NO_PROXY does not cover ${uncovered.join(", ")}, ` +
    `so calls to the local model runtime would go through the proxy. Set NO_PROXY=${LOOPBACK_NO_PROXY}.`
  );
}

/** The model runtime would be reached through a proxy; the app refuses to start that client. */
export class ProxyBypassError extends Error {
  override readonly name = "ProxyBypassError";
}

/** Throws `ProxyBypassError` when `env` would send local model traffic through a proxy. */
export function assertNoProxyForLoopback(runtime: string, env: Env = process.env): void {
  const problem = proxyBypassProblem(env);
  if (problem !== undefined) {
    throw new ProxyBypassError(`${runtime}: ${problem}`);
  }
}
