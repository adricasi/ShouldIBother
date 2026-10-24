import { readdirSync, readFileSync } from "node:fs";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), { encoding: "utf8" });

const tokens = read("../docs/design/tokens.css");
const styles = postcss.parse(read("../src/web/styles.css"));

/** Every stylesheet of the app: the shared one and the ones beside their screens (src/web/**). */
const WEB_DIR = new URL("../src/web/", import.meta.url);
const allStylesheets = readdirSync(WEB_DIR, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".css"))
  .map((file) => ({ file, root: postcss.parse(readFileSync(new URL(file, WEB_DIR), "utf8")) }));

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
    ["ink-2", "leaf-soft"], // the rank hero (REQ-025): ink-3-text is only 4.39:1 here
    ["ink-2", "coral-soft"], // small print on a safety alert
    ["ink-2", "amber-soft"], // small print in a rescue alert
    ["line", "ink"], // inactive tabs on the tab bar
    ["ink-2", "line"], // the muted "No bet" pill
    ["sun-soft", "ink"], // the odds band word on the odds tile
  ];

  it.each(TEXT_PAIRS)("%s on %s is at least 4.5:1", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("frontend standard: the stylesheet uses tokens, not literals", () => {
  it("has no colour literal outside the token file", () => {
    const literals: string[] = [];
    for (const { file, root } of allStylesheets) {
      root.walkDecls((declaration) => {
        if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(declaration.value)) {
          literals.push(`${file} ${declaration.prop}: ${declaration.value}`);
        }
      });
    }
    expect(allStylesheets.length).toBeGreaterThan(3);
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

describe("the sloth mascot's stylesheet (design.md Round 3, item 13)", () => {
  const sloth = postcss.parse(read("../src/web/ui/sloth.css"));

  it("moves only while the device allows motion: every animation sits in prefers-reduced-motion: no-preference", () => {
    const outside: string[] = [];
    let inside = 0;
    sloth.walkDecls("animation", (declaration) => {
      const rule = declaration.parent;
      const query = rule?.parent;
      if (
        query?.type === "atrule" &&
        (query as postcss.AtRule).params.includes("prefers-reduced-motion: no-preference")
      ) {
        inside += 1;
      } else {
        outside.push(declaration.value);
      }
    });
    expect(outside).toEqual([]);
    expect(inside).toBeGreaterThan(0);
  });
});
