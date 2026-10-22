import type { networkInterfaces } from "node:os";

export type InterfaceMap = ReturnType<typeof networkInterfaces>;

export interface AllowlistInput {
  /** Port the app listens on; the Host allowlist entries carry it. */
  readonly port: number;
  readonly interfaces: InterfaceMap;
  /** Extra Host values from config, e.g. the Windows LAN IP behind a netsh portproxy. */
  readonly allowedHosts: readonly string[];
  /** Normalised origins from config, e.g. `https://machine.tailnet.ts.net`. */
  readonly publicOrigins: readonly string[];
}

export interface Allowlist {
  /** Accepted `Host` header values (lower case, with port when the browser sends one). */
  readonly hosts: ReadonlySet<string>;
  /** Accepted `Origin` values for POST, PUT and DELETE (AC-001.4). */
  readonly origins: ReadonlySet<string>;
  /** Hosts reached through an https public origin: pairing there sets `Secure` (AC-001.10). */
  readonly secureHosts: ReadonlySet<string>;
}

/** `host:port`, plus the bare host on port 80, which browsers omit from Host and Origin. */
function withPort(host: string, port: number): string[] {
  return port === 80 ? [`${host}:80`, host] : [`${host}:${port}`];
}

function bracketIfIpv6(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

/**
 * The Host values a configured entry stands for: an entry with a port is taken as written, a
 * bare host gets the app port. A bare IPv6 address is bracketed first, as it appears in Host.
 */
function configuredHostValues(entry: string, port: number): string[] {
  const host = entry.toLowerCase();
  if (host.startsWith("[")) {
    return host.includes("]:") ? [host] : withPort(host, port);
  }
  const colons = host.split(":").length - 1;
  if (colons === 1) {
    return [host];
  }
  return withPort(colons > 1 ? `[${host}]` : host, port);
}

/**
 * Builds the Host and Origin allowlists once at start-up (AC-001.9, AC-001.4, design.md
 * "Security design"). Sources: localhost, 127.0.0.1, every address of every network interface,
 * `config.allowedHosts` and the hosts of `config.publicOrigins`. An origin is an allowlisted
 * host over http, or an entry of `config.publicOrigins`.
 */
export function buildAllowlist(input: AllowlistInput): Allowlist {
  const local = new Set<string>(["localhost", "127.0.0.1"]);
  for (const addresses of Object.values(input.interfaces)) {
    for (const address of addresses ?? []) {
      // Zone-scoped IPv6 (fe80::...%eth0) cannot appear in a Host header.
      if (!address.address.includes("%")) {
        local.add(bracketIfIpv6(address.address));
      }
    }
  }

  const hosts = new Set<string>();
  const origins = new Set<string>();
  const secureHosts = new Set<string>();

  const addHostOverHttp = (host: string): void => {
    const lower = host.toLowerCase();
    hosts.add(lower);
    origins.add(`http://${lower}`);
  };

  for (const host of local) {
    withPort(host, input.port).forEach(addHostOverHttp);
  }
  for (const host of input.allowedHosts) {
    configuredHostValues(host, input.port).forEach(addHostOverHttp);
  }
  for (const origin of input.publicOrigins) {
    const url = new URL(origin);
    hosts.add(url.host.toLowerCase());
    origins.add(url.origin.toLowerCase());
    if (url.protocol === "https:") {
      secureHosts.add(url.host.toLowerCase());
    }
  }
  return { hosts, origins, secureHosts };
}

/** One line for the start-up banner, so the owner sees what the server will answer to. */
export function describeAllowlist(allowlist: Allowlist): string {
  return `Allowed hosts: ${[...allowlist.hosts].sort().join(", ")}`;
}
