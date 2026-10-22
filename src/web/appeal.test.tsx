// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppealAction } from "./AppealParts.js";
import { receiptSchema, type Receipt } from "./api.js";
import { ReceiptCard } from "./SettleParts.js";
import { lossReceipt, winReceipt } from "./test-data.js";

const appealed: Receipt = {
  ...winReceipt,
  points: 30,
  can_appeal: false,
  appeal: {
    first: {
      verdict: "normal_loss",
      verdict_title: "Loss",
      points: -50,
      reason: "The soil is dry.",
      settled_at: "2026-10-23T06:05:00.000Z",
    },
    changed: true,
  },
};

describe("REQ-023: the appeal on the receipt", () => {
  it("AC-023.1: an appealed receipt shows the first verdict it replaced and says the second is final", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={appealed} />);
    expect(html).toContain("Appealed");
    expect(html).toContain("First verdict: Loss (−50).");
    expect(html).toContain("The new photo changed the verdict.");
    expect(html).toContain("Gemma first said: The soil is dry.");
    expect(html).toContain("The second verdict is final. There is no second appeal.");
  });

  it("AC-023.3: a confirmed verdict says so instead of 'changed'", () => {
    const html = renderToStaticMarkup(
      <ReceiptCard receipt={{ ...appealed, appeal: { ...appealed.appeal!, changed: false } }} />,
    );
    expect(html).toContain("The new photo confirmed the verdict.");
    expect(html).not.toContain("changed the verdict");
  });

  it("AC-029.2: a receipt without an appeal block shows no appeal text", () => {
    const html = renderToStaticMarkup(<ReceiptCard receipt={lossReceipt} />);
    expect(html).not.toContain("Appealed");
    expect(html).not.toContain("appeal");
  });

  it("the receipt schema accepts the server's appeal block and a receipt without it", () => {
    expect(receiptSchema.parse(appealed).appeal?.first.points).toBe(-50);
    expect(receiptSchema.parse(winReceipt).appeal).toBeUndefined();
    expect(receiptSchema.parse({ ...winReceipt, can_appeal: true }).can_appeal).toBe(true);
  });
});

describe("REQ-023: the appeal action", () => {
  let container: HTMLElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const render = (receipt: Receipt, onAppeal = vi.fn(), busy = false): typeof onAppeal => {
    act(() => {
      root.render(<AppealAction receipt={receipt} busy={busy} onAppeal={onAppeal} />);
    });
    return onAppeal;
  };

  it("AC-023.1: offers one photo picker and sends the chosen file with the bet id", () => {
    const onAppeal = render({ ...lossReceipt, can_appeal: true });
    expect(container.textContent).toContain("Appeal with a new photo");
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    expect(input.accept).toBe("image/*");
    const file = new File(["x"], "after.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file] });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onAppeal).toHaveBeenCalledWith(lossReceipt.bet_id, file);
  });

  it("AC-023.2: offers nothing once appealed, when the server does not offer it, or with the flag off", () => {
    render(appealed);
    expect(container.textContent).toBe("");
    render({ ...lossReceipt, can_appeal: false });
    expect(container.textContent).toBe("");
    render(lossReceipt);
    expect(container.textContent).toBe("");
  });

  it("disables the picker while another request is running", () => {
    render({ ...lossReceipt, can_appeal: true }, vi.fn(), true);
    expect(container.querySelector<HTMLInputElement>("input[type=file]")!.disabled).toBe(true);
  });
});
