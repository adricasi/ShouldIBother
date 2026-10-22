import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { buildAllowlist, type Allowlist } from "./auth/allowlist.js";
import { AuthStore } from "./auth/store.js";
import { DEFAULT_PORT, loadServerConfig, type ServerConfig } from "./config.js";
import { DATABASE_FILE, resolveDataDir } from "./data-dir.js";
import { migrate, openDatabase, type Db } from "./db.js";
import { MIGRATIONS } from "./migrations/index.js";
import { pickLanAddress } from "./network.js";

const portSchema = z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT);

export interface Runtime {
  readonly db: Db;
  readonly store: AuthStore;
  readonly port: number;
  readonly lanAddress: string | undefined;
  readonly config: ServerConfig;
  readonly allowlist: Allowlist;
}

/**
 * What the server and the CLI share: port, data folder with the migrated database, network
 * addresses and the allowlists, all derived from the environment and `config/server.json`.
 */
export function loadRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const port = portSchema.parse(env["SIB_PORT"]);
  const config = loadServerConfig();
  const interfaces = networkInterfaces();
  const lanAddress = pickLanAddress(interfaces, env["SIB_LAN_ADDRESS"]);
  const db = openDatabase(join(resolveDataDir(env), DATABASE_FILE));
  migrate(db, MIGRATIONS);
  return {
    db,
    store: new AuthStore(db, Date.now),
    port,
    lanAddress,
    config,
    allowlist: buildAllowlist({
      port,
      interfaces,
      allowedHosts: config.allowedHosts,
      publicOrigins: config.publicOrigins,
    }),
  };
}
