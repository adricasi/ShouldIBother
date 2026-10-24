/**
 * Snapshots and datasets must not end up in a commit (this repository is public, NFR-002). The
 * commands write only outside a git working tree, or where git ignores the files.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export class OutputInsideRepositoryError extends Error {
  override readonly name = "OutputInsideRepositoryError";
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The nearest existing ancestor of `path` (the path itself when it exists). A dangling symlink on
 * the way is refused: it would send the files to a place that does not exist yet, unchecked.
 */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    if (lexists(current)) {
      throw new OutputInsideRepositoryError(
        `${current} is a symlink to a place that does not exist, so where the files would go can not be checked. Use a real folder.`,
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  // A file on the way (writing there fails later, with its own message): look at its folder.
  return statSync(current).isDirectory() ? current : dirname(current);
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

/** `ok` false with `missing` true: there is no `git` binary on PATH (a container image without it). */
function git(
  cwd: string,
  args: readonly string[],
): { ok: boolean; stdout: string; missing?: boolean } {
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
    if ((error as { code?: string }).code === "ENOENT") {
      return { ok: false, stdout: "", missing: true };
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
      // Without a git binary (a container image) the folder is safe only when no `.git` entry
      // exists in it or any parent; with one, keep refusing.
      if (hasGitMarker(real)) {
        throw new OutputInsideRepositoryError(
          top.missing === true
            ? `${file} is inside a git working tree and git is not installed to check whether it is ignored, so it is not written. Write outside the repository.`
            : `${file} is inside a git working tree that git cannot read, so it is not written. Write outside the repository.`,
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

/**
 * Writes `content` to `path` through `<path>.tmp`, created exclusively (`wx`) after removing any
 * leftover, so a symlink planted at the temporary name is never followed; the rename then replaces
 * whatever is at `path`, a symlink included, instead of writing through it.
 */
export function writeFileExclusive(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, content, { flag: "wx" });
  renameSync(temporary, path);
}
