import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), { encoding: "utf8" });

const styles = read("../src/web/styles.css");
const tokens = read("../docs/design/tokens.css");

/** The text between the braces that open at `start` (the first "{" at or after it). */
function blockAt(source: string, start: number): string {
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error("unbalanced braces");
}

function blockOf(source: string, header: string): string {
  const start = source.indexOf(header);
  expect(start, `${header} is missing`).toBeGreaterThanOrEqual(0);
  return blockAt(source, start);
}

describe("T-017: REQ-017 stamp motion in the stylesheet", () => {
  it("AC-017.1: lands from scale 1.6 to 1 at -8 degrees over 220-280 ms", () => {
    const rule = blockOf(styles, ".stamp-animated {");
    expect(rule).toContain("animation: stamp-land var(--motion-stamp)");

    const keyframes = blockOf(styles, "@keyframes stamp-land");
    const from = blockOf(keyframes, "from");
    const to = blockOf(keyframes, "to");
    expect(from).toContain("rotate(-8deg) scale(1.6)");
    expect(to).toContain("rotate(-8deg) scale(1)");

    const token = /--motion-stamp:\s*(\d+)ms/.exec(tokens);
    const duration = Number(token?.[1]);
    expect(duration).toBeGreaterThanOrEqual(220);
    expect(duration).toBeLessThanOrEqual(280);
  });

  it("AC-017.2: reduced motion fades the stamp and animates no transform", () => {
    const media = blockOf(styles, "@media (prefers-reduced-motion: reduce)");
    expect(media).toContain(".stamp-animated");
    expect(media).toContain("animation: stamp-fade");
    expect(media).not.toMatch(/stamp-land|transform|scale|rotate/);

    const fade = blockOf(styles, "@keyframes stamp-fade");
    expect(fade).toContain("opacity");
    expect(fade).not.toMatch(/transform|scale|rotate/);

    const fadeDuration = /animation: stamp-fade (\d+)ms/.exec(media);
    expect(Number(fadeDuration?.[1])).toBeGreaterThanOrEqual(220);
    expect(Number(fadeDuration?.[1])).toBeLessThanOrEqual(280);
  });
});
