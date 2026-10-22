import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), { encoding: "utf8" });

const styles = postcss.parse(read("../src/web/ui/split-flap.css"));
const tokens = read("../docs/design/tokens.css");

const REDUCED_MOTION = /prefers-reduced-motion:\s*reduce/;

function rulesFor(root: Container, selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector === selector) found.push(rule);
  });
  return found;
}

function declarationsOf(container: Container, property: string): string[] {
  const values: string[] = [];
  container.walkDecls(property, (declaration: Declaration) => {
    values.push(declaration.value);
  });
  return values;
}

function reducedMotionFlipBlocks(): AtRule[] {
  const blocks: AtRule[] = [];
  styles.walkAtRules("media", (atRule) => {
    if (REDUCED_MOTION.test(atRule.params) && rulesFor(atRule, ".flap-flip").length > 0) {
      blocks.push(atRule);
    }
  });
  return blocks;
}

describe("T-027: REQ-026 split-flap motion in the stylesheet", () => {
  it("AC-026.1: a changed tile flips with the flap token, at most 300 ms", () => {
    const [base] = rulesFor(styles, ".flap-flip").filter((rule) => rule.parent?.type === "root");
    expect(declarationsOf(base as Rule, "animation")).toEqual([
      "flap-flip var(--motion-flap) both",
    ]);

    const duration = Number(/--motion-flap:\s*(\d+)ms/.exec(tokens)?.[1]);
    expect(duration).toBeGreaterThan(0);
    expect(duration).toBeLessThanOrEqual(300);

    let frames: AtRule | undefined;
    styles.walkAtRules("keyframes", (atRule) => {
      if (atRule.params === "flap-flip") frames = atRule;
    });
    expect(frames, "@keyframes flap-flip is missing").toBeDefined();
  });

  it("AC-026.2: reduced motion removes the flip animation altogether", () => {
    const blocks = reducedMotionFlipBlocks();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const rule = rulesFor(block, ".flap-flip")[0] as Rule;
      expect(declarationsOf(rule, "animation")).toEqual(["none"]);
      expect(declarationsOf(rule, "transform")).toEqual([]);
    }
  });

  it("AC-026.2: the reduced-motion rule comes after the base flip rule, so it wins", () => {
    const [base] = rulesFor(styles, ".flap-flip").filter((rule) => rule.parent?.type === "root");
    const [block] = reducedMotionFlipBlocks();
    expect((base as Rule).source?.start?.offset).toBeLessThan(
      (block as AtRule).source?.start?.offset ?? -1,
    );
  });

  it("the static tile is not transformed, so reduced motion shows a plain tile", () => {
    for (const selector of [".flap", ".flap.large", ".flap.small"]) {
      for (const rule of rulesFor(styles, selector)) {
        expect(declarationsOf(rule, "transform")).toEqual([]);
        expect(declarationsOf(rule, "animation")).toEqual([]);
      }
    }
  });
});

function colour(name: string): number[] {
  const hex = new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`, "i").exec(tokens)?.[1];
  if (hex === undefined) throw new Error(`Token --color-${name} not found`);
  return [0, 2, 4].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
}

function contrast(foreground: string, background: string): number {
  const luminance = ([r = 0, g = 0, b = 0]: number[]): number =>
    0.2126 * r + 0.7152 * g + 0.0722 * b;
  const [light = 0, dark = 0] = [luminance(colour(foreground)), luminance(colour(background))].sort(
    (a, b) => b - a,
  );
  return (light + 0.05) / (dark + 0.05);
}

describe("T-027: NFR-009 the board's colour pairs", () => {
  it.each([
    ["sun", "ink-2", "tile characters on the tile"],
    ["sun", "ink", "tile characters, lazy bars on the board"],
    ["sun-soft", "ink", "board captions"],
    ["card", "ink", "board text"],
    ["line", "ink", "attribution and source line"],
    ["ink", "sun", "the lazy window tag"],
  ])("%s on %s is at least 4.5:1 (%s)", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it("the grey bars stand out from the board by at least 3:1", () => {
    expect(contrast("ink-3", "ink")).toBeGreaterThanOrEqual(3);
  });
});
