import { describe, expect, it } from "vitest";

import { greet } from "../src/index.js";

describe("greet", () => {
  it("returns a greeting", () => {
    expect(greet("Ada")).toBe("Hello, Ada!");
  });

  it("trims whitespace", () => {
    expect(greet("  Ada  ")).toBe("Hello, Ada!");
  });

  it.each(["", "   "])("rejects empty name %j", (name) => {
    expect(() => greet(name)).toThrow("name must not be empty");
  });
});
