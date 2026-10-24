import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DemoGuard, startDemo, type GuardedProcess } from "../src/demo/command.js";
import { seedDemoData } from "../src/demo/seed.js";

vi.mock("../src/demo/seed.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/demo/seed.js")>();
  return { ...original, seedDemoData: vi.fn(original.seedDemoData) };
});

/** A stand-in for `process` that records listeners and exits. */
class FakeProcess implements GuardedProcess {
  readonly listeners = new Map<string, () => void>();
  readonly exits: (number | undefined)[] = [];
  exitCode: number | string | null | undefined;
  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  off(event: string): this {
    this.listeners.delete(event);
    return this;
  }
  exit(code?: number): void {
    this.exits.push(code);
  }
  emit(event: string): void {
    this.listeners.get(event)?.();
  }
}

describe("sib demo cleanup (AC-029.4)", () => {
  let parent = "";
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "sib-demo-cleanup-"));
  });
  afterEach(() => {
    vi.mocked(seedDemoData).mockClear();
    rmSync(parent, { recursive: true, force: true });
  });

  it("removes the temporary folder when the seeding throws", async () => {
    vi.mocked(seedDemoData).mockRejectedValueOnce(new Error("seed broke"));
    await expect(startDemo({ parentDir: parent, output: () => undefined })).rejects.toThrow(
      "seed broke",
    );
    expect(readdirSync(parent)).toEqual([]);
  });

  it("removes the temporary folder when the server does not start (port taken)", async () => {
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(
        startDemo({ parentDir: parent, port, output: () => undefined }),
      ).rejects.toThrow();
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      blocker.close();
    }
  });

  it("removes the folder in the exit event, as after an uncaught exception", () => {
    const proc = new FakeProcess();
    const guard = new DemoGuard(proc, () => undefined);
    const dir = join(parent, "sib-demo-x");
    mkdirSync(dir);
    guard.track(dir);
    proc.emit("exit");
    expect(existsSync(dir)).toBe(false);
  });

  it("a signal while starting removes the folder at once and exits with 128 + the signal", () => {
    const proc = new FakeProcess();
    const guard = new DemoGuard(proc, () => undefined);
    const dir = join(parent, "sib-demo-y");
    mkdirSync(dir);
    guard.track(dir);
    proc.emit("SIGTERM");
    expect(existsSync(dir)).toBe(false);
    expect(proc.exits).toEqual([143]);
    mkdirSync(dir);
    proc.emit("SIGHUP");
    expect(proc.exits).toEqual([143, 129]);
  });

  it("the first signal while running stops cleanly; a repeated one removes the folder and exits", async () => {
    const proc = new FakeProcess();
    const printed: string[] = [];
    const guard = new DemoGuard(proc, (text) => printed.push(text));
    const dir = join(parent, "sib-demo-z");
    mkdirSync(dir);
    guard.track(dir);
    let release: () => void = () => undefined;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    guard.running(() => closing);
    proc.emit("SIGINT");
    expect(proc.exits).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    proc.emit("SIGINT");
    expect(existsSync(dir)).toBe(false);
    expect(proc.exits).toEqual([1]);
    release();
    await closing;
    await Promise.resolve();
    expect(printed).toContain("Sample data deleted.");
  });
});
