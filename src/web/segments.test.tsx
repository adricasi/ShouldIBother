// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupJump } from "./SlipsParts.js";

describe("GroupJump: the segmented control of Slips (mockup 05)", () => {
  let container: HTMLElement;
  let root: Root;
  const scrollIntoView = vi.fn();
  /** Where each heading's top is, by id; headings are below the reading line unless a test says so. */
  const tops: Record<string, number> = {};

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = scrollIntoView;
    for (const key of Object.keys(tops)) {
      Reflect.deleteProperty(tops, key);
    }
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      return { top: tops[this.id] ?? 1000 } as DOMRect;
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <>
          <GroupJump
            groups={[
              { id: "a-title", label: "Settle now", count: 1 },
              { id: "b-title", label: "Waiting", count: 2 },
              { id: "c-title", label: "Settled" },
            ]}
          />
          <h2 id="a-title" tabIndex={-1}>
            A
          </h2>
          <h2 id="b-title" tabIndex={-1}>
            B
          </h2>
          <h2 id="c-title" tabIndex={-1}>
            C
          </h2>
        </>,
      );
    });
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    scrollIntoView.mockReset();
  });

  const buttons = (): HTMLButtonElement[] => [...container.querySelectorAll("button")];
  const current = (): string[] =>
    buttons()
      .filter((button) => button.getAttribute("aria-current") === "true")
      .map((button) => button.textContent ?? "");
  const rect = (id: string, top: number): void => {
    tops[id] = top;
  };
  const scrolled = (): void => {
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  };

  it("starts on the first group, says so with aria-current, and has no aria-pressed", () => {
    expect(current()).toEqual(["Settle now · 1"]);
    expect(container.querySelector("[aria-pressed]")).toBeNull();
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Jump to a group",
    );
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Settle now · 1",
      "Waiting · 2",
      "Settled",
    ]);
  });

  it("jumps to the group's heading, moves focus there and shows it as current", () => {
    act(() => {
      buttons()[1]?.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.activeElement?.id).toBe("b-title");
    expect(current()).toEqual(["Waiting · 2"]);
  });

  it("keeps the tapped group current through the scroll it causes, then follows the page again", () => {
    vi.useFakeTimers();
    act(() => {
      buttons()[2]?.click();
    });
    // The page is on its way: headings are not yet where the reading line would pick the third.
    rect("a-title", -300);
    rect("b-title", -20);
    rect("c-title", 900);
    scrolled();
    expect(current()).toEqual(["Settled"]);
    // The scroll stops; the next scroll event is the page's own again.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    scrolled();
    expect(current()).toEqual(["Waiting · 2"]);
    vi.useRealTimers();
  });

  it("follows the scroll: the group whose heading passed the reading line is current", () => {
    rect("a-title", -300);
    rect("b-title", -20);
    rect("c-title", 900);
    scrolled();
    expect(current()).toEqual(["Waiting · 2"]);
  });

  it("at the bottom of the page the last group is current, even if its heading is below the line", () => {
    rect("a-title", -900);
    rect("b-title", -400);
    rect("c-title", 700);
    Object.defineProperty(window, "scrollY", { value: 500, configurable: true });
    Object.defineProperty(document.documentElement, "scrollHeight", {
      value: window.innerHeight + 500,
      configurable: true,
    });
    scrolled();
    expect(current()).toEqual(["Settled"]);
    Reflect.deleteProperty(window, "scrollY");
    Reflect.deleteProperty(document.documentElement, "scrollHeight");
  });

  it("reads the page once on mount, so a screen opened part-way down starts on the right group", () => {
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    // The second heading is above the reading line already when the control mounts.
    rect("a-title", -300);
    rect("b-title", -20);
    rect("c-title", 900);
    act(() => {
      root.render(
        <>
          <GroupJump
            groups={[
              { id: "a-title", label: "Settle now" },
              { id: "b-title", label: "Waiting" },
              { id: "c-title", label: "Settled" },
            ]}
          />
          <h2 id="a-title">A</h2>
          <h2 id="b-title">B</h2>
          <h2 id="c-title">C</h2>
        </>,
      );
    });
    expect(current()).toEqual(["Waiting"]);
  });
});
