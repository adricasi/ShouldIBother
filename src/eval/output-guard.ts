import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Eval reports and recorded fixtures hold what a model said about staged inputs. They are
 * written outside any git working tree, or where git ignores them, so a report cannot be
 * committed by accident (this repository is public, NFR-002).
 */
export class OutputGuardError extends Error {
  override readonly name = "OutputGuardError";
}

/** The nearest existing folder of `path`: itself when it is one, else its closest parent. */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current) || !statSync(current).isDirectory()) {
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

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

/** git's answer: its stdout, or `undefined` when it exits non-zero (1: not ignored, 128: no repository). */
function git(cwd: string, args: readonly string[]): string | undefined {
  // A git hook sets GIT_DIR and friends, which would point git at another repository.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) {
    delete env[name];
  }
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
  } catch (error) {
    if (typeof (error as { status?: unknown }).status === "number") {
      return undefined;
    }
    throw new OutputGuardError(
      "Cannot run git to check whether the output folder is inside a repository. Install git or write outside any repository.",
      { cause: error },
    );
  }
}

/**
 * Throws `OutputGuardError` when one of `files` would be written inside a git working tree
 * without being ignored by it. A path outside every repository is fine.
 */
export function assertNotCommittable(files: readonly string[]): void {
  for (const file of files) {
    const absolute = resolve(file);
    const nearest = existingAncestor(absolute);
    const real = realpathSync(nearest);
    const toplevel = git(real, ["rev-parse", "--show-toplevel"])?.trim();
    if (toplevel === undefined || toplevel === "") {
      if (hasGitMarker(real)) {
        throw new OutputGuardError(
          `${file} is inside a git working tree that git cannot read, so it is not written. Write outside the repository.`,
        );
      }
      continue;
    }
    // git reports real paths: rebuild the file's path under the real ancestor.
    const inside = join(real, relative(nearest, absolute));
    if (git(toplevel, ["check-ignore", "-q", "--", inside]) === undefined) {
      throw new OutputGuardError(
        `${file} is inside the git working tree ${toplevel} and git does not ignore it, so it could be committed. ` +
          "Write outside the repository (the default is the data folder) or to a git-ignored folder.",
      );
    }
  }
}

/** True when `path` is `folder` or inside it (symlinks resolved as far as the paths exist). */
export function isInside(path: string, folder: string): boolean {
  const real = (value: string): string => {
    const nearest = existingAncestor(resolve(value));
    return join(realpathSync(nearest), relative(nearest, resolve(value)));
  };
  const rel = relative(real(folder), real(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
