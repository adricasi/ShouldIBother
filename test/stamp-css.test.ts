import { readFileSync } from "node:fs";
import postcss, { type AtRule, type Container, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), { encoding: "utf8" });

const styles = postcss.parse(read("../src/web/styles.css"));
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

function keyframes(name: string): AtRule {
  let found: AtRule | undefined;
  styles.walkAtRules("keyframes", (atRule) => {
    if (atRule.params === name) found = atRule;
  });
  expect(found, `@keyframes ${name} is missing`).toBeDefined();
  return found as AtRule;
}

/** The keyframe selected by `step` ("from" or "to"), matched as a whole word. */
function step(frames: AtRule, wanted: "from" | "to"): Rule {
  const found = (frames.nodes as Rule[]).find((node) =>
    new RegExp(`(^|\\s)${wanted}\\s*$`).test(node.selector),
  );
  expect(found, `${wanted} step is missing`).toBeDefined();
  return found as Rule;
}

/** Every reduced-motion @media block that holds a rule for the animated stamp. */
function reducedMotionStampBlocks(): AtRule[] {
  const blocks: AtRule[] = [];
  styles.walkAtRules("media", (atRule) => {
    if (REDUCED_MOTION.test(atRule.params) && rulesFor(atRule, ".stamp-animated").length > 0) {
      blocks.push(atRule);
    }
  });
  return blocks;
}

describe("T-017: REQ-017 stamp motion in the stylesheet", () => {
  it("AC-017.1: lands from scale 1.6 to 1 at -8 degrees over 220-280 ms", () => {
    const [base] = rulesFor(styles, ".stamp-animated").filter(
      (rule) => rule.parent?.type === "root",
    );
    expect(base).toBeDefined();
    expect(declarationsOf(base as Rule, "animation")).toEqual([
      "stamp-land var(--motion-stamp) both",
    ]);

    const frames = keyframes("stamp-land");
    expect(declarationsOf(step(frames, "from"), "transform")).toEqual(["rotate(-8deg) scale(1.6)"]);
    expect(declarationsOf(step(frames, "to"), "transform")).toEqual(["rotate(-8deg) scale(1)"]);

    const duration = Number(/--motion-stamp:\s*(\d+)ms/.exec(tokens)?.[1]);
    expect(duration).toBeGreaterThanOrEqual(220);
    expect(duration).toBeLessThanOrEqual(280);
  });

  it("AC-017.2: reduced motion fades the stamp and animates no transform", () => {
    const blocks = reducedMotionStampBlocks();
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const rule = rulesFor(block, ".stamp-animated")[0] as Rule;
      const [animation] = declarationsOf(rule, "animation");
      expect(animation).toMatch(/^stamp-fade \d+ms /);
      const milliseconds = Number(/(\d+)ms/.exec(animation ?? "")?.[1]);
      expect(milliseconds).toBeGreaterThanOrEqual(220);
      expect(milliseconds).toBeLessThanOrEqual(280);
      expect(declarationsOf(rule, "transform")).toEqual([]);
    }

    const fade = keyframes("stamp-fade");
    expect(declarationsOf(fade, "opacity").length).toBeGreaterThan(0);
    expect(declarationsOf(fade, "transform")).toEqual([]);
  });

  it("AC-017.2: the static stamp keeps its -8 degree tilt, so reduced motion shows no jump", () => {
    const [base] = rulesFor(styles, ".stamp").filter((rule) => rule.parent?.type === "root");
    expect(declarationsOf(base as Rule, "transform")).toEqual(["rotate(-8deg)"]);
  });

  it("AC-017.2: the reduced-motion rule comes after the base animated rule, so it wins", () => {
    const [base] = rulesFor(styles, ".stamp-animated").filter(
      (rule) => rule.parent?.type === "root",
    );
    const [block] = reducedMotionStampBlocks();
    expect((base as Rule).source?.start?.offset).toBeLessThan(
      (block as AtRule).source?.start?.offset ?? -1,
    );
  });
});
