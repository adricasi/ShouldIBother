import { Writable } from "node:stream";

import { pino } from "pino";
import { describe, expect, it } from "vitest";

import { LOGGER_OPTIONS } from "../src/server/app.js";

describe("request logging", () => {
  it("NFR-001: cookie and authorization headers are redacted from log lines", () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // Same options as the Fastify logger; plain pino has no `req` serializer that would
    // drop the headers before redaction, so this exercises the redact paths themselves.
    pino(LOGGER_OPTIONS, stream).info({
      req: { headers: { cookie: "sid=SECRET-SESSION", authorization: "Bearer SECRET-TOKEN" } },
    });
    const output = lines.join("");
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("SECRET-SESSION");
    expect(output).not.toContain("SECRET-TOKEN");
  });
});
