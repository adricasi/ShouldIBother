import { describe, expect, it } from "vitest";

import { startServer } from "../src/server/main.js";

describe("startServer", () => {
  it("rejects an invalid SIB_PORT before listening", async () => {
    await expect(startServer({ SIB_PORT: "99999" })).rejects.toThrow();
    await expect(startServer({ SIB_PORT: "abc" })).rejects.toThrow();
  });
});
