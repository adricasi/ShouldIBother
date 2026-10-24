import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("the web entry point and the page's Content-Security-Policy", () => {
  it("imports ./zod-config.js before anything else, so zod never probes eval", () => {
    const source = readFileSync(new URL("../src/web/main.tsx", import.meta.url), "utf8");
    const firstImport = /^import\s+(?:[^"']*from\s+)?["']([^"']+)["'];?$/m.exec(source);
    expect(firstImport?.[1]).toBe("./zod-config.js");
  });
});
