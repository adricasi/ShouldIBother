// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GroupJump } from "./SlipsParts.js";

describe("GroupJump: the segmented control of Slips (mockup 05)", () => {
  let container: HTMLElement;
  let root: Root;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Element.prototype.scrollIntoView = scrollIntoView;
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

  it("starts on the first group and says so with aria-pressed", () => {
    expect(buttons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(buttons().map((button) => button.textContent)).toEqual([
      "Settle now · 1",
      "Waiting · 2",
      "Settled",
    ]);
  });

  it("jumps to the group's heading, moves focus there and shows it as the shown group", () => {
    act(() => {
      buttons()[1]?.click();
    });
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.activeElement?.id).toBe("b-title");
    expect(buttons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("follows the scroll: the group whose heading passed the reading line is shown", () => {
    const rect = (top: number) => () => ({ top }) as DOMRect;
    document.getElementById("a-title")!.getBoundingClientRect = rect(-300);
    document.getElementById("b-title")!.getBoundingClientRect = rect(-20);
    document.getElementById("c-title")!.getBoundingClientRect = rect(900);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(buttons().map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });
});
