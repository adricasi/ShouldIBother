import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES_DIR } from "../server/model/fake.js";

import type { LoggedCall } from "./call-log.js";
import { assertNotCommittable, isInside, OutputGuardError } from "./output-guard.js";
import type { CaseRun } from "./types.js";

export interface RecordingFacts {
  readonly model: string;
  readonly modelDigest: string | null;
  /** ISO date of the run. */
  readonly date: string;
}

/** The fixture file of one job of one case, in the format `FakeModelClient` reads. */
function fixtureOf(
  caseId: string,
  calls: readonly LoggedCall[],
  facts: RecordingFacts,
  outcome: string,
): Record<string, unknown> {
  return {
    description:
      `Recorded from ${facts.model}${facts.modelDigest === null ? "" : ` (${facts.modelDigest})`} on ${facts.date.slice(0, 10)} ` +
      `for staged eval case ${caseId}; ${outcome}. Review by hand before copying into test/fixtures/gemma/.`,
    // The model name stays the fake's own: a fixture must never pose as Gemma (NFR-010).
    steps: calls.map((call) => {
      if (call.error !== undefined) {
        return { error: call.error };
      }
      let content: unknown = call.content;
      try {
        const parsed: unknown = JSON.parse(call.content);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          content = parsed;
        }
      } catch {
        // Not JSON: kept as written, which is what an invalid-JSON fixture is.
      }
      return {
        ...(call.toolCalls.length === 0
          ? {}
          : { toolCalls: call.toolCalls.map((t) => ({ name: t.name, arguments: t.arguments })) }),
        content,
      };
    }),
  };
}

/**
 * The scenario files `--record-fixtures` would write, as `<job>/<case id>.json`. The case id is
 * the scenario name, so fixtures stay keyed by job and scenario, never by the input.
 */
export function fixturesOf(
  runs: readonly CaseRun[],
  facts: RecordingFacts,
): { path: string; fixture: Record<string, unknown> }[] {
  return runs.flatMap((run) => {
    const jobs = [...new Set(run.calls.map((call) => call.job))];
    return jobs.map((job) => ({
      path: join(job, `${run.record.id}.json`),
      fixture: fixtureOf(
        run.record.id,
        run.calls.filter((call) => call.job === job),
        facts,
        run.record.valid ? "valid" : `invalid (${run.record.failure ?? "unknown"})`,
      ),
    }));
  });
}

/**
 * Writes candidate fixtures to `dir` for a hand review. It never touches an existing file, and
 * refuses `test/fixtures/gemma/` itself: the builder copies reviewed files there.
 */
export function writeCandidateFixtures(
  dir: string,
  runs: readonly CaseRun[],
  facts: RecordingFacts,
): { written: string[]; skipped: string[] } {
  const files = fixturesOf(runs, facts);
  if (isInside(dir, FIXTURES_DIR)) {
    throw new OutputGuardError(
      `${dir} is inside test/fixtures/gemma/. Record somewhere else, review the files by hand and copy them there.`,
    );
  }
  assertNotCommittable(files.map((file) => join(dir, file.path)));
  const written: string[] = [];
  const skipped: string[] = [];
  for (const { path, fixture } of files) {
    const target = join(dir, path);
    mkdirSync(join(dir, path, ".."), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      written.push(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        skipped.push(target);
      } else {
        throw error;
      }
    }
  }
  return { written, skipped };
}
