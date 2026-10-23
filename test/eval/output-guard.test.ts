import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OutputGuardError, assertNotCommittable, isInside } from "../../src/eval/output-guard.js";

import { tempDir } from "./support.js";

function repo(): string {
  const directory = tempDir();
  execFileSync("git", ["init", "-q"], { cwd: directory });
  writeFileSync(join(directory, ".gitignore"), "ignored-reports/\n");
  return directory;
}

describe("NFR-002: eval output never lands where it could be committed", () => {
  it("allows a folder outside every repository, existing or not", () => {
    const outside = tempDir();
    expect(() => {
      assertNotCommittable([join(outside, "report.json"), join(outside, "a", "b", "report.md")]);
    }).not.toThrow();
  });

  it("refuses a folder inside a repository that git does not ignore, even one that does not exist yet", () => {
    const root = repo();
    expect(() => {
      assertNotCommittable([join(root, "reports", "report.json")]);
    }).toThrow(OutputGuardError);
    mkdirSync(join(root, "existing"));
    expect(() => {
      assertNotCommittable([join(root, "existing", "report.md")]);
    }).toThrow(/could be committed/);
  });

  it("allows a folder that git ignores", () => {
    const root = repo();
    expect(() => {
      assertNotCommittable([join(root, "ignored-reports", "x", "report.json")]);
    }).not.toThrow();
  });

  it("follows a symlink out of an ignored folder into the repository", () => {
    const root = repo();
    mkdirSync(join(root, "tracked"));
    symlinkSync(join(root, "tracked"), join(root, "ignored-reports"));
    expect(() => {
      assertNotCommittable([join(root, "ignored-reports", "report.json")]);
    }).toThrow(OutputGuardError);
  });

  it("isInside tells a folder from its neighbours and parents", () => {
    const root = tempDir();
    expect(isInside(join(root, "a", "b"), join(root, "a"))).toBe(true);
    expect(isInside(join(root, "a"), join(root, "a"))).toBe(true);
    expect(isInside(join(root, "ab"), join(root, "a"))).toBe(false);
    expect(isInside(root, join(root, "a"))).toBe(false);
  });

  it("without git installed, a folder outside every repository is still fine", () => {
    const outside = tempDir();
    const saved = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      expect(() => {
        assertNotCommittable([join(outside, "report.json")]);
      }).not.toThrow();
    } finally {
      process.env["PATH"] = saved;
    }
  });

  it("without git installed, a folder inside a .git tree is refused (fail closed)", () => {
    const root = repo();
    const saved = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      expect(() => {
        assertNotCommittable([join(root, "reports", "report.json")]);
      }).toThrow(OutputGuardError);
    } finally {
      process.env["PATH"] = saved;
    }
  });
});
