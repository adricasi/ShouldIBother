import { z } from "zod";

/**
 * The page's Content-Security-Policy has no `'unsafe-eval'`. zod probes `new Function("")` to
 * decide whether it may compile its parsers; the probe throws and is caught, but the browser
 * still reports it as a CSP violation in the console. `jitless` skips the probe and uses the
 * interpreted parsers, which is plenty fast for the few small answers the app reads.
 * Import this module before any module that builds a schema: zod decides when a schema is built.
 */
z.config({ jitless: true });
