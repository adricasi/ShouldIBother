import type { NetworkInterfaceInfo } from "node:os";
import { Writable } from "node:stream";

import type { InjectOptions, LightMyRequestResponse } from "fastify";

import { buildApp, type FeaturePlugins } from "../src/server/app.js";
import { buildAllowlist, type InterfaceMap } from "../src/server/auth/allowlist.js";
import { AuthStore } from "../src/server/auth/store.js";
import { migrate, openDatabase, type Db } from "../src/server/db.js";
import { parseFlags, type FlagName } from "../src/server/flags.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

export const PORT = 8787;
export const LAN_ADDRESS = "192.168.1.20";
export const LOCAL_HOST = `localhost:${PORT}`;
export const LOCAL_ORIGIN = `http://${LOCAL_HOST}`;
/** An https public origin such as a Tailscale Serve URL; its Host has no port. */
export const PUBLIC_ORIGIN = "https://bookie.tail1234.ts.net";
export const PUBLIC_HOST = "bookie.tail1234.ts.net";
export const T0 = Date.UTC(2026, 9, 22, 8, 0, 0);

export class FakeClock {
  current = T0;
  readonly now = (): number => this.current;
  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function networkInterface(address: string, internal: boolean): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

export const FAKE_INTERFACES: InterfaceMap = {
  lo: [networkInterface("127.0.0.1", true)],
  eth0: [networkInterface(LAN_ADDRESS, false)],
};

export interface HarnessOptions {
  /** Flags to switch on; `score` is on unless given, because the app routes hang off it. */
  flags?: Partial<Record<FlagName, boolean>>;
  publicOrigins?: string[];
  allowedHosts?: string[];
  features?: FeaturePlugins;
  logger?: boolean;
}

export class Harness {
  readonly clock = new FakeClock();
  readonly db: Db;
  readonly store: AuthStore;
  readonly printed: string[] = [];
  readonly logLines: string[] = [];
  app!: Awaited<ReturnType<typeof buildApp>>;

  constructor() {
    this.db = openDatabase(":memory:");
    migrate(this.db, MIGRATIONS);
    this.store = new AuthStore(this.db, this.clock.now);
  }

  /** Same-origin request from the laptop's browser unless the options say otherwise. */
  request(options: InjectOptions & { url: string }): Promise<LightMyRequestResponse> {
    return this.app.inject({
      ...options,
      headers: { host: LOCAL_HOST, ...options.headers },
    });
  }

  /** Issues a token, exchanges it and returns the `Cookie` header value of the new session. */
  async pairDevice(headers: Record<string, string> = {}, remoteAddress?: string): Promise<string> {
    const { token } = this.store.issuePairingToken();
    const response = await this.request({
      method: "GET",
      url: `/pair?token=${token}`,
      headers,
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });
    return cookieHeaderFrom(response);
  }

  async close(): Promise<void> {
    await this.app.close();
    this.db.close();
  }
}

/** The `name=value` pair of the response's Set-Cookie, as a browser would send it back. */
export function cookieHeaderFrom(response: LightMyRequestResponse): string {
  const setCookie = response.headers["set-cookie"];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (first === undefined) {
    throw new Error(`No Set-Cookie header (status ${response.statusCode})`);
  }
  return first.split(";")[0] ?? "";
}

const created: Harness[] = [];

/** Closes every harness a test created, so a failing assertion cannot leak servers or databases. */
export async function closeAllHarnesses(): Promise<void> {
  await Promise.all(created.splice(0).map((harness) => harness.close()));
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const harness = new Harness();
  created.push(harness);
  const logStream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      harness.logLines.push(chunk.toString());
      done();
    },
  });
  harness.app = await buildApp({
    flags: parseFlags(options.flags ?? { score: true }),
    ...(options.features === undefined ? {} : { features: options.features }),
    logger: options.logger ?? false,
    logStream,
    auth: {
      store: harness.store,
      allowlist: buildAllowlist({
        port: PORT,
        interfaces: FAKE_INTERFACES,
        allowedHosts: options.allowedHosts ?? [],
        publicOrigins: options.publicOrigins ?? [],
      }),
      print: (line) => harness.printed.push(line),
    },
  });
  return harness;
}

/** App data behind the guard: a page, an API route and a photo route, as later tasks add them. */
export const SECRET = "SECRET-HOUSEHOLD-DATA";
export const appRoutes: FeaturePlugins = {
  score: (app) => {
    app.get("/", () => `<html>${SECRET}</html>`);
    app.get("/api/today", () => ({ secret: SECRET }));
    app.get("/photos/:id", () => SECRET);
    app.post("/api/cards", () => ({ secret: SECRET }));
    app.put("/api/cards/1", () => ({ secret: SECRET }));
    app.delete("/api/bets/1", () => ({ secret: SECRET }));
    return Promise.resolve();
  },
};
