import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page } from "@playwright/test";

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), {
  encoding: "utf8",
});

interface AxeResults {
  violations: { id: string; help: string; nodes: { target: unknown[] }[] }[];
}

/**
 * Runs axe-core in the page, colour contrast included (jsdom cannot compute it), and returns the
 * violations as readable lines. Tags: WCAG 2.0/2.1/2.2 A and AA.
 */
export async function axeViolations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  const results = await page.evaluate(
    async () =>
      (await (
        globalThis as unknown as {
          axe: { run: (context: unknown, options: unknown) => Promise<unknown> };
        }
      ).axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
      })) as AxeResults,
  );
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes
        .slice(0, 3)
        .map((node) => String(node.target))
        .join(" | ")})`,
  );
}
