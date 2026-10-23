import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EVALS_DIR, EVAL_JOBS, defaultCasesPath } from "../../src/eval/cases.js";
import { EVAL_JOB_SPECS } from "../../src/eval/jobs.js";

const SETS = [
  ...EVAL_JOBS.map((job) => ({ job, path: defaultCasesPath(job) })),
  { job: "judge" as const, path: join(EVALS_DIR, "judge", "photo-cases.json") },
];

describe("T-010/T-030: the committed eval sets", () => {
  it.each(SETS)("$job: $path holds 20 valid cases with unique ids", ({ job, path }) => {
    const cases = EVAL_JOB_SPECS[job].prepare(path);
    expect(cases).toHaveLength(20);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(20);
  });

  it("only the photo sets name photos, and each photo is named once per case", () => {
    const named = (path: string, job: (typeof SETS)[number]["job"]): string[] =>
      EVAL_JOB_SPECS[job].prepare(path).flatMap((entry) => entry.photos.map((photo) => photo.name));
    for (const { job, path } of SETS) {
      const photos = named(path, job);
      if (job === "inspector" || path.endsWith("photo-cases.json")) {
        expect(photos.length).toBeGreaterThanOrEqual(20);
        expect(new Set(photos).size).toBe(photos.length);
      } else {
        expect(photos).toEqual([]);
      }
    }
  });

  it("every photo case says what to stage", () => {
    for (const { job, path } of SETS) {
      for (const entry of EVAL_JOB_SPECS[job].prepare(path)) {
        for (const photo of entry.photos) {
          expect(photo.staging.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it("AGENTS.md: no image is committed under evals/ (photos are staged by the builder)", () => {
    const files = (directory: string): string[] =>
      readdirSync(directory).flatMap((name) => {
        const path = join(directory, name);
        return statSync(path).isDirectory() ? files(path) : [path];
      });
    const images = files(EVALS_DIR).filter((path) => /\.(jpe?g|png|webp|heic|gif)$/i.test(path));
    expect(images).toEqual([]);
  });

  it("the sets cover the edge cases the tasks ask for", () => {
    const ids = (job: (typeof EVAL_JOBS)[number]): string[] =>
      EVAL_JOB_SPECS[job].prepare(defaultCasesPath(job)).map((entry) => entry.id);
    expect(ids("bookmaker").join(" ")).toMatch(/storm/);
    expect(ids("bookmaker").join(" ")).toMatch(/heatwave/);
    expect(ids("laundry-planner").join(" ")).toMatch(/storm/);
    expect(ids("laundry-planner").join(" ")).toMatch(/heatwave/);
    expect(ids("listener").join(" ")).toMatch(/injection/);
    expect(ids("safety").join(" ")).toMatch(/injection/);
  });

  it("a judge case with a before photo says what to stage for each photo", () => {
    const cases = EVAL_JOB_SPECS.judge.prepare(join(EVALS_DIR, "judge", "photo-cases.json"));
    const withBefore = cases.filter((entry) => entry.photos.length === 2);
    expect(withBefore.length).toBeGreaterThan(10);
    for (const entry of withBefore) {
      const [before, after] = entry.photos;
      expect(before?.name).toContain("-before-");
      expect(after?.name).toContain("-after-");
      expect(before?.staging).not.toBe(after?.staging);
    }
  });
});
