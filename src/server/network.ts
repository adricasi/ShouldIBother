import { createServer, isIPv4, type Server } from "node:net";
import type { networkInterfaces } from "node:os";

import type { FastifyInstance } from "fastify";

type InterfaceMap = ReturnType<typeof networkInterfaces>;

/** Container and virtual-bridge interfaces never carry the phone-facing address. */
const VIRTUAL_INTERFACE = /^(docker|br-|veth)/;

/** Rank of an RFC 1918 address: the home LAN is almost always 192.168/16, then 10/8, then 172.16/12. */
function privateRank(address: string): number | undefined {
  const [a = 0, b = 0] = address.split(".").map(Number);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return undefined;
}

/**
 * The address the phone reaches the laptop on (design.md, Network exposure): the first private
 * IPv4 address of an active, non-loopback, non-virtual interface, or the `SIB_LAN_ADDRESS`
 * override (which must itself be private or loopback).
 * Public and tailnet (100.64/10) addresses are never chosen: the app listens on the LAN, and
 * Tailscale Serve reaches it through loopback. Returns undefined when no LAN address exists
 * (the server then listens on loopback only).
 */
export function pickLanAddress(interfaces: InterfaceMap, override?: string): string | undefined {
  if (override !== undefined && override !== "") {
    const allowed =
      isIPv4(override) && (privateRank(override) !== undefined || override.startsWith("127."));
    if (!allowed) {
      throw new Error(
        `SIB_LAN_ADDRESS must be a private LAN address (192.168/16, 10/8, 172.16/12) or loopback, got ${override}`,
      );
    }
    return override;
  }
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => ({ address: entry.address, rank: privateRank(entry.address) }))
    .filter((entry): entry is { address: string; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank);
  return candidates[0]?.address;
}

export interface ListenTarget {
  readonly port: number;
  /** The LAN address to listen on in addition to 127.0.0.1. */
  readonly lanAddress?: string | undefined;
}

/**
 * Fastify listens on one address, but the app must listen on 127.0.0.1 and the LAN address and
 * on nothing else (never 0.0.0.0, which would also expose every other interface, including a
 * VPN). The Fastify server listens on 127.0.0.1; a plain TCP listener on the LAN address hands
 * each accepted socket to the same HTTP server, so both addresses share one app, one set of
 * hooks and one connection pool. Must be called before the app is ready.
 */
export async function listenLoopbackAndLan(
  app: FastifyInstance,
  target: ListenTarget,
): Promise<void> {
  let lan: Server | undefined;
  if (target.lanAddress !== undefined) {
    lan = createServer((socket) => {
      app.server.emit("connection", socket);
    });
    const lanServer = lan;
    app.addHook("onClose", () => new Promise<void>((resolve) => lanServer.close(() => resolve())));
  }
  await app.listen({ host: "127.0.0.1", port: target.port });
  if (lan !== undefined && target.lanAddress !== undefined) {
    const lanServer = lan;
    const lanAddress = target.lanAddress;
    const lanPort = target.port === 0 ? portOf(app) : target.port;
    await new Promise<void>((resolve, reject) => {
      lanServer.once("error", reject);
      lanServer.listen({ host: lanAddress, port: lanPort }, () => {
        lanServer.off("error", reject);
        // Accept errors (e.g. EMFILE) after start-up are logged; they must not crash the server.
        lanServer.on("error", (error) => {
          app.log.error({ err: error }, "LAN listener error");
        });
        resolve();
      });
    }).catch(async (error: unknown) => {
      await app.close();
      throw error;
    });
  }
}

function portOf(app: FastifyInstance): number {
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The server is not listening on a TCP port");
  }
  return address.port;
}
