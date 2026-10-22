import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { buildAllowlist, type Allowlist } from "./auth/allowlist.js";
import { AuthStore } from "./auth/store.js";
import { CONFIG_DIR, loadServerConfig, type ServerConfig } from "./config.js";
import { DATABASE_FILE, resolveDataDir } from "./data-dir.js";
import { migrate, openDatabase, type Db } from "./db.js";
import { MIGRATIONS } from "./migrations/index.js";
import { pickLanAddress } from "./network.js";

const portSchema = z.coerce.number().int().min(1).max(65535);

export interface Runtime {
  /** The household-private data folder: database, photos, logs. */
  readonly dataDir: string;
  readonly db: Db;
  readonly store: AuthStore;
  readonly port: number;
  readonly lanAddress: string | undefined;
  readonly config: ServerConfig;
  readonly allowlist: Allowlist;
}

/**
 * What the server and the CLI share: port, data folder with the migrated database, network
 * addresses and the allowlists. The port is `SIB_PORT`, else `port` in `config/server.json`
 * (default 8787), so `sib pair` prints the same port the server listens on.
 */
export function loadRuntime(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
): Runtime {
  const config = loadServerConfig(configDir);
  const port = env["SIB_PORT"] === undefined ? config.port : portSchema.parse(env["SIB_PORT"]);
  const interfaces = networkInterfaces();
  const lanAddress = pickLanAddress(interfaces, env["SIB_LAN_ADDRESS"]);
  const dataDir = resolveDataDir(env);
  const db = openDatabase(join(dataDir, DATABASE_FILE));
  migrate(db, MIGRATIONS);
  return {
    dataDir,
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
