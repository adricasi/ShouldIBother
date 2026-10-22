import type { Page } from "@playwright/test";

interface FocusReading {
  readonly name: string;
  readonly style: string;
  readonly width: number;
  /** Contrast of the outline colour against the colour it is drawn on; null when not computable. */
  readonly contrast: number | null;
}

const MAX_STOPS = 80;
const MIN_STOPS = 5;

/**
 * Presses Tab through the whole page and reads, at every stop, the focus outline of the focused
 * control (the visible label for the visually hidden file input): style, width and its contrast
 * against the colour right next to it (the parent's background for an outside outline, the
 * control's own for an inset one). Returns one line per control that fails (no outline, or under
 * 3:1, WCAG 1.4.11 / 2.4.7).
 */
export async function focusRingProblems(page: Page): Promise<string[]> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const seen = new Set<string>();
  const problems: string[] = [];
  for (let stop = 0; stop < MAX_STOPS; stop += 1) {
    await page.keyboard.press("Tab");
    const reading = await page.evaluate((): (FocusReading & { id: string }) | null => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null || active === document.body) {
        return null;
      }
      const target =
        active.classList.contains("photo-input") && active.nextElementSibling instanceof HTMLElement
          ? active.nextElementSibling
          : active;
      const all = Array.from(document.querySelectorAll("*"));
      const id = `${all.indexOf(active)}`;
      const style = getComputedStyle(target);
      const parse = (color: string): [number, number, number, number] => {
        const parts = (color.match(/[\d.]+/g) ?? []).map(Number);
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
      };
      const opaqueBackground = (from: HTMLElement | null): [number, number, number] => {
        for (let node = from; node !== null; node = node.parentElement) {
          const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
          if (a > 0) {
            return [r, g, b];
          }
        }
        return [255, 255, 255];
      };
      const luminance = ([r, g, b]: [number, number, number]): number => {
        const lin = (value: number): number => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const inset = Number.parseFloat(style.outlineOffset) < 0;
      const outline = parse(style.outlineColor);
      const background = opaqueBackground(inset ? target : target.parentElement);
      const [light, dark] = [
        luminance([outline[0], outline[1], outline[2]]),
        luminance(background),
      ].sort((a, b) => b - a);
      return {
        id,
        name: (target.textContent ?? target.tagName).trim().slice(0, 40),
        style: style.outlineStyle,
        width: Number.parseFloat(style.outlineWidth),
        contrast: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05),
      };
    });
    if (reading === null || seen.has(reading.id)) {
      break;
    }
    seen.add(reading.id);
    if (reading.style === "none" || !(reading.width > 0)) {
      problems.push(`${reading.name}: no visible focus outline`);
    } else if (reading.contrast !== null && reading.contrast < 3) {
      problems.push(`${reading.name}: focus outline contrast ${reading.contrast.toFixed(2)}:1`);
    }
  }
  if (seen.size < MIN_STOPS) {
    problems.push(
      `Tab reached only ${String(seen.size)} controls; the walk is not testing the page`,
    );
  }
  return problems;
}
