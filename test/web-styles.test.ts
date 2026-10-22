import { readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), { encoding: "utf8" });

const tokens = read("../docs/design/tokens.css");
const styles = postcss.parse(read("../src/web/styles.css"));

function token(name: string): string {
  const found = new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, "i").exec(tokens);
  if (found?.[1] === undefined) {
    throw new Error(`Token --color-${name} not found`);
  }
  return found[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(token(foreground)), luminance(token(background))].sort(
    (a, b) => b - a,
  );
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe("NFR-009: token contrast (text pairs the stylesheet uses)", () => {
  const TEXT_PAIRS: readonly [string, string][] = [
    ["ink", "paper"],
    ["ink", "card"],
    ["ink-2", "card"],
    ["ink-2", "paper"],
    ["ink-3-text", "paper"],
    ["ink-3-text", "card"],
    ["leaf", "card"],
    ["leaf", "paper"],
    ["leaf", "leaf-soft"],
    ["amber-text", "paper"],
    ["amber-text", "card"],
    ["amber-text", "sun-soft"],
    ["coral", "card"],
    ["sun", "ink"],
    ["sun-soft", "ink"],
    ["ink", "sun-soft"],
    ["ink", "rain-soft"],
    ["ink", "coral-soft"],
    ["ink", "amber-soft"],
    ["ink", "leaf-soft"],
  ];

  it.each(TEXT_PAIRS)("%s on %s is at least 4.5:1", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("frontend standard: the stylesheet uses tokens, not literals", () => {
  it("has no colour literal outside the token file", () => {
    const literals: string[] = [];
    styles.walkDecls((declaration) => {
      if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(declaration.value)) {
        literals.push(`${declaration.prop}: ${declaration.value}`);
      }
    });
    expect(literals).toEqual([]);
  });

  it("keeps every interactive control at the 44 px tap minimum", () => {
    const chip = styles.nodes.find(
      (node) => node.type === "rule" && node.selector === ".chip,\n.button",
    );
    expect(chip?.toString()).toContain("min-height: var(--tap-min)");
    expect(chip?.toString()).toContain("min-width: var(--tap-min)");
  });
});

describe("fonts are self-hosted", () => {
  it("names no remote URL in the page, the stylesheet or the entry point", () => {
    for (const file of ["../src/web/index.html", "../src/web/styles.css", "../src/web/main.tsx"]) {
      expect(read(file), file).not.toMatch(/https?:\/\//);
    }
  });
});
