import { describe, expect, it, vi } from "vitest";

import { createScheduler } from "../src/server/scheduler.js";
import { migrate, openDatabase } from "../src/server/db.js";
import { MIGRATIONS } from "../src/server/migrations/index.js";

describe("scheduler settlement step", () => {
  it("runs one settlement pass at a time and reports errors without stopping", async () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    let release: (() => void) | undefined;
    const settle = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = () => {
            resolve(2);
          };
        }),
    );
    const scheduler = createScheduler({ db, now: () => 1 }, () => undefined, { settle });
    const first = scheduler.tickSettlement();
    const second = scheduler.tickSettlement();
    expect(settle).toHaveBeenCalledTimes(1);
    release?.();
    expect(await first).toBe(2);
    expect(await second).toBe(2);
    // A finished pass lets the next one start.
    const next = scheduler.tickSettlement();
    expect(settle).toHaveBeenCalledTimes(2);
    release?.();
    await next;
    db.close();
  });

  it("does nothing without a settlement step", async () => {
    const db = openDatabase(":memory:");
    migrate(db, MIGRATIONS);
    const scheduler = createScheduler({ db, now: () => 1 }, () => undefined);
    expect(await scheduler.tickSettlement()).toBe(0);
    db.close();
  });
});
