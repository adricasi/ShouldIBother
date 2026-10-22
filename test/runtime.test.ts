import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadRuntime } from "../src/server/runtime.js";
import { startServer, type RunningServer } from "../src/server/main.js";

let dir: string;
let configDir: string;
let server: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sib-runtime-"));
  configDir = `${dir}/config/`;
  // Same files the repository ships, but under a temp folder so a developer's real
  // config/server.json cannot change the test.
  mkdirSync(configDir, { recursive: true });
  writeFileSync(`${configDir}server.example.json`, JSON.stringify({ port: 8787 }));
  writeFileSync(`${configDir}flags.json`, "{}");
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function get(
  port: number,
  path: string,
  host: string,
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, headers: { host }, agent: false },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          ...(res.headers.location ? { location: res.headers.location } : {}),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("runtime wiring", () => {
  it("the banner, the allowlist and the listen port agree, and close is clean", async () => {
    const port = await freePort();
    const output: string[] = [];
    server = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_PORT: String(port), SIB_LAN_ADDRESS: "127.0.0.2" },
      { output: (text) => output.push(text), configDir },
    );
    const text = output.join("\n");

    expect(server.runtime.port).toBe(port);
    expect(text).toContain(`Listening on 127.0.0.1:${port} and 127.0.0.2:${port}`);
    expect(text).toContain(`Allowed hosts: `);
    expect(text).toContain(`localhost:${port}`);
    expect(text).toContain(`127.0.0.2:${port}`);
    const link = new RegExp(`http://127\\.0\\.0\\.1:${port}/pair\\?token=([A-Za-z0-9_-]{43})`).exec(
      text,
    );
    expect(link?.[1]).toBeDefined();
    expect(text).toContain(`http://127.0.0.2:${port}/pair?token=`);

    // The printed link works on the real sockets, with the Host a browser would send.
    const paired = await get(port, `/pair?token=${link?.[1] ?? ""}`, `127.0.0.1:${port}`);
    expect(paired).toEqual({ status: 303, location: "/" });
    expect((await get(port, "/healthz", `127.0.0.1:${port}`)).status).toBe(401);
    expect((await get(port, "/healthz", "evil.example")).status).toBe(421);
    expect(output.join("\n")).toContain("Paired a device");

    expect(statSync(join(dir, "data")).mode & 0o777).toBe(0o700);
    const { db } = server.runtime;
    await server.close();
    expect(db.open).toBe(false);
    server = undefined;
  });

  it("closes the database when the port cannot be bound", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as AddressInfo).port;
    try {
      await expect(
        startServer(
          { SIB_DATA_DIR: join(dir, "data"), SIB_PORT: String(port) },
          { output: () => undefined, configDir },
        ),
      ).rejects.toThrow();
    } finally {
      taken.close();
    }
  });
});

describe("loadRuntime port", () => {
  it("uses the port of config/server.json, and SIB_PORT overrides it", () => {
    writeFileSync(`${configDir}server.json`, JSON.stringify({ port: 9191 }));
    const env = { SIB_DATA_DIR: join(dir, "data") };
    const fromConfig = loadRuntime(env, configDir);
    expect(fromConfig.port).toBe(9191);
    expect(fromConfig.allowlist.hosts.has("localhost:9191")).toBe(true);
    fromConfig.db.close();

    const overridden = loadRuntime({ ...env, SIB_PORT: "9292" }, configDir);
    expect(overridden.port).toBe(9292);
    expect(overridden.allowlist.hosts.has("localhost:9292")).toBe(true);
    overridden.db.close();
  });

  it("defaults to 8787 and rejects an invalid SIB_PORT before touching the data folder", () => {
    const env = { SIB_DATA_DIR: join(dir, "data") };
    const defaulted = loadRuntime(env, configDir);
    expect(defaulted.port).toBe(8787);
    defaulted.db.close();
    expect(() =>
      loadRuntime({ ...env, SIB_DATA_DIR: join(dir, "never"), SIB_PORT: "99999" }, configDir),
    ).toThrow();
    expect(() => statSync(join(dir, "never"))).toThrow();
  });
});
