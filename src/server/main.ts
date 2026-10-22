import { z } from "zod";

import { buildApp } from "./app.js";
import { loadFlags } from "./flags.js";

const portSchema = z.coerce.number().int().min(1).max(65535).default(3000);

/**
 * Starts the server on the loopback interface only. LAN binding, pairing and the session
 * guard arrive with T-003 (NFR-001).
 */
export async function startServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = portSchema.parse(env["SIB_PORT"]);
  const app = await buildApp({ flags: loadFlags(), logger: true });
  await app.listen({ host: "127.0.0.1", port });
}
