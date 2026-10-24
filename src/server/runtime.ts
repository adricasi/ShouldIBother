import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { buildAllowlist, buildHostedAllowlist, type Allowlist } from "./auth/allowlist.js";
import { AuthStore } from "./auth/store.js";
import { CONFIG_DIR, loadServerConfig, type ServerConfig } from "./config.js";
import { DATABASE_FILE, resolveDataDir } from "./data-dir.js";
import { migrate, openDatabase, type Db } from "./db.js";
import { MIGRATIONS } from "./migrations/index.js";
import {
  HOME_SETTINGS,
  ignoredHostedVariables,
  parseModeScope,
  parseModeSettings,
  type HostedAccessSettings,
  type ModeSettings,
} from "./mode.js";
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
  /** Home or hosted mode with its settings, parsed once here (REQ-032); absent means home. */
  readonly mode?: ModeSettings | HostedAccessSettings;
  /** Hosted variables that were set in home mode and are ignored (AC-032.1); logged once at start. */
  readonly ignoredHostedVariables?: readonly string[];
}

/**
 * What the server and the CLI share: port, data folder with the migrated database, network
 * addresses and the allowlists. The port is `SIB_PORT`, else `port` in `config/server.json`
 * (default 8787), so `sib pair` prints the same port the server listens on.
 */
export function loadRuntime(
  env: NodeJS.ProcessEnv = process.env,
  configDir: string = CONFIG_DIR,
  /** `sib demo` is always home mode, whatever the environment says. */
  options: {
    readonly forceHome?: boolean;
    /**
     * What the caller needs of the hosted settings: all of them (the server, the default), the
     * public origin (`sib pair`) or only the mode (`sib forget-devices`, `sib devices`, `sib
     * export`), so a revoke works without the model or the key.
     */
    readonly scope?: "full" | "pair" | "mode";
  } = {},
): Runtime {
  // First, so a hosted start with a missing setting fails before anything is opened (AC-032.2).
  const scope = options.scope ?? "full";
  const mode =
    options.forceHome === true
      ? HOME_SETTINGS
      : scope === "full"
        ? parseModeSettings(env)
        : parseModeScope(env, scope);
  const config = loadServerConfig(configDir);
  const port = env["SIB_PORT"] === undefined ? config.port : portSchema.parse(env["SIB_PORT"]);
  const interfaces = networkInterfaces();
  // A hosted server has no LAN address: it answers behind the reverse proxy only (AC-032.3).
  const lanAddress =
    mode.mode === "hosted" ? undefined : pickLanAddress(interfaces, env["SIB_LAN_ADDRESS"]);
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
    allowlist:
      mode.mode === "hosted" && mode.publicOrigin !== undefined
        ? buildHostedAllowlist(mode.publicOrigin)
        : buildAllowlist({
            port,
            interfaces,
            allowedHosts: config.allowedHosts,
            publicOrigins: config.publicOrigins,
          }),
    mode,
    ignoredHostedVariables: mode.mode === "home" ? ignoredHostedVariables(env) : [],
  };
}
