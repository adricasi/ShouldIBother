import { readFileSync } from "node:fs";

import postcss from "postcss";
import { describe, expect, it } from "vitest";

const styles = postcss.parse(
  readFileSync(new URL("../src/web/voice/voice.css", import.meta.url), { encoding: "utf8" }),
);

describe("voice sheet stylesheet (frontend standard, NFR-009)", () => {
  it("uses tokens, not colour literals", () => {
    const literals: string[] = [];
    styles.walkDecls((declaration) => {
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(declaration.value)) {
        literals.push(`${declaration.prop}: ${declaration.value}`);
      }
    });
    expect(literals).toEqual([]);
  });

  it("turns the meter's transition off when reduced motion is preferred", () => {
    let found = false;
    styles.walkAtRules("media", (atRule) => {
      if (
        /prefers-reduced-motion:\s*reduce/.test(atRule.params) &&
        atRule.toString().includes("transition: none")
      ) {
        found = true;
      }
    });
    expect(found).toBe(true);
  });
});
