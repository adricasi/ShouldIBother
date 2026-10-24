import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutputInsideRepositoryError, assertNotCommittable } from "../src/backtest/output-guard.js";
import { resolveDataDir } from "../src/server/data-dir.js";

/*
 * NFR-013: the hosted image has no git binary. The data-folder guard (resolveDataDir and
 * `sib export`) then accepts a folder only when no `.git` entry exists in it or any parent, and
 * still refuses one inside a working tree.
 */

let root: string;
let savedPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sib-nogit-"));
  savedPath = process.env["PATH"];
  process.env["PATH"] = "";
});
afterEach(() => {
  process.env["PATH"] = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("the data-folder guard without a git binary (empty PATH)", () => {
  it("accepts a data folder that is in no git working tree, new or existing", () => {
    const data = join(root, "data");
    expect(resolveDataDir({ SIB_DATA_DIR: data })).toBe(data);
    // The second start finds the folder (and its permissions) already there.
    expect(resolveDataDir({ SIB_DATA_DIR: data })).toBe(data);
    expect(() => {
      assertNotCommittable([join(root, "export", "export.json")]);
    }).not.toThrow();
  });

  it("refuses a data folder inside a working tree, however deep and whether it exists yet", () => {
    mkdirSync(join(root, ".git"));
    expect(() => resolveDataDir({ SIB_DATA_DIR: join(root, "data") })).toThrow(
      OutputInsideRepositoryError,
    );
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(() => resolveDataDir({ SIB_DATA_DIR: join(root, "a", "b", "data") })).toThrow(
      /git is not installed/,
    );
    expect(() => {
      assertNotCommittable([join(root, "export.json")]);
    }).toThrow(OutputInsideRepositoryError);
  });

  it("refuses when .git is a file, as in a worktree or a submodule", () => {
    writeFileSync(join(root, ".git"), "gitdir: /elsewhere\n");
    expect(() => {
      assertNotCommittable([join(root, "x.json")]);
    }).toThrow(OutputInsideRepositoryError);
  });
});
