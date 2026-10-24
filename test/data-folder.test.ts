import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDataDir } from "../src/server/data-dir.js";

const REPO = resolve(fileURLToPath(new URL("../", import.meta.url)));
const inside = (path: string): boolean => {
  const from = relative(REPO, path);
  return from === "" || (!from.startsWith(`..${sep}`) && from !== ".." && !from.startsWith(sep));
};

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AC-015.1: the database and the photos live in a data folder outside the source tree, listed in .gitignore", () => {
  it("defaults to a folder in the person's home, not in the repository", () => {
    // Resolved on a throwaway HOME so the test never creates the real folder.
    const home = mkdtempSync(join(tmpdir(), "sib-home-"));
    made.push(home);
    const previous = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const dir = resolveDataDir({});
      expect(dir).toBe(join(homedir(), ".should-i-bother"));
      expect(inside(dir)).toBe(false);
      expect(existsSync(dir)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = previous;
      }
    }
  });

  it("is only ever inside the repository when someone points SIB_DATA_DIR there, and .gitignore then covers data/", () => {
    // The one in-tree folder the project names is data/, and it is ignored (design.md, Data model).
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());
    expect(ignore).toContain("data/");
    expect(inside(join(REPO, "data"))).toBe(true);
    const override = mkdtempSync(join(tmpdir(), "sib-data-"));
    made.push(override);
    expect(resolveDataDir({ SIB_DATA_DIR: override })).toBe(override);
    expect(inside(override)).toBe(false);
  });

  it("keeps the photos folder inside the data folder, so one folder is everything", () => {
    const main = readFileSync(join(REPO, "src/server/main.ts"), "utf8");
    expect(main).toContain("join(runtime.dataDir, PHOTOS_DIR)");
  });
});
