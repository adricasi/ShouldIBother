/**
 * Snapshots and datasets must not end up in a commit (this repository is public, NFR-002). The
 * commands write only outside a git working tree, or where git ignores the files.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export class OutputInsideRepositoryError extends Error {
  override readonly name = "OutputInsideRepositoryError";
}

/** The nearest existing ancestor of `path` (the path itself when it exists). */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

/** True when `folder` or a parent has a `.git` entry: git's own check can fail (ownership). */
function hasGitMarker(folder: string): boolean {
  let current = folder;
  for (;;) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }
    const parent = dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

/** The environment without `GIT_DIR` and friends, which a git hook sets and which would point git elsewhere. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    delete env[name];
  }
  return env;
}

function git(cwd: string, args: readonly string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvironment(),
    });
    return { ok: true, stdout };
  } catch (error) {
    // Status 1 is `git check-ignore`'s "not ignored"; 128 is "not a repository".
    const status = (error as { status?: number | null }).status;
    if (typeof status === "number") {
      return { ok: false, stdout: "" };
    }
    throw new OutputInsideRepositoryError(
      "Cannot run git to check whether the output folder is inside a repository. Install git or write outside any repository.",
    );
  }
}

/**
 * Throws `OutputInsideRepositoryError` if one of `files` would be written inside a git working
 * tree without being ignored by it. A path outside any repository is fine.
 */
export function assertNotCommittable(files: readonly string[]): void {
  for (const file of files) {
    const absolute = resolve(file);
    const nearest = existingAncestor(absolute);
    const real = realpathSync(nearest);
    const top = git(real, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      if (hasGitMarker(real)) {
        throw new OutputInsideRepositoryError(
          `${file} is inside a git working tree that git cannot read, so it is not written. Write outside the repository.`,
        );
      }
      continue;
    }
    // Git reports real paths: rebuild the file's path under the real ancestor.
    const toplevel = top.stdout.trim();
    const inside = join(real, relative(nearest, absolute));
    if (!git(toplevel, ["check-ignore", "-q", "--", inside]).ok) {
      throw new OutputInsideRepositoryError(
        `${file} is inside the git working tree ${toplevel} and git does not ignore it, so it could be committed. ` +
          "Write outside the repository (the default is the data folder) or to a git-ignored folder.",
      );
    }
  }
}
