import type { AnswerMode, ToolUseMode } from "../server/gemma/runner.js";
import type { ModelHealth } from "../server/model/client.js";

import type { EvalJob } from "./cases.js";
import { PHOTO_JUDGEMENT_BUDGET_MS, type Summary } from "./summary.js";
import type { CaseRecord } from "./types.js";

/** What the report says about the run besides the numbers. */
export interface ReportMeta {
  readonly job: EvalJob;
  /** ISO date and time of the run. */
  readonly date: string;
  /** `fake` runs on recorded fixtures, not on Gemma: the numbers only prove the pipeline. */
  readonly mode: "ollama" | "fake" | "digitalocean";
  readonly health: ModelHealth;
  /** The model name and digest as the runtime answered; null when no call was answered. */
  readonly model: string | null;
  readonly modelDigest: string | null;
  readonly promptVersions: readonly string[];
  readonly runner: {
    readonly toolUse: ToolUseMode;
    readonly answerMode: AnswerMode;
    readonly callTimeoutMs: number;
    readonly deadlineMs: number;
  };
  /** The case file as given; its file name only, no folder of the household. */
  readonly casesFile: string;
}

export interface EvalReport extends ReportMeta {
  readonly summary: Summary;
  readonly cases: readonly CaseRecord[];
}

export const FAKE_WARNING =
  "FAKE MODEL (SIB_FAKE_MODEL=1): these answers come from recorded fixtures, NOT from Gemma. " +
  "They only prove the pipeline; do not record them for T-010 or T-030.";

export function buildReport(
  meta: ReportMeta,
  records: readonly CaseRecord[],
  summary: Summary,
): EvalReport {
  return { ...meta, summary, cases: records };
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

function resultCell(record: CaseRecord): string {
  if (!record.valid) {
    return `NO ${record.failure ?? "invalid"}`;
  }
  return record.steps.some((step) => step.status === "unsure") ? "ok (asks)" : "ok";
}

function expectedCell(record: CaseRecord): string {
  return record.matchesExpectation === null ? "-" : record.matchesExpectation ? "yes" : "no";
}

const COLUMNS = [
  "#",
  "case",
  "valid",
  "answer",
  "tool",
  "calls",
  "retries",
  "time s",
  "expected",
] as const;

function cells(record: CaseRecord, index: number): string[] {
  return [
    String(index + 1),
    record.id,
    resultCell(record),
    record.answerKey,
    record.toolMode ?? "-",
    String(record.calls),
    String(record.retries),
    seconds(record.latencyMs),
    expectedCell(record),
  ];
}

/** Fixed-width text table; `widths` lets a caller print rows one by one as the cases finish. */
export function columnWidths(ids: readonly string[]): number[] {
  const idWidth = Math.max("case".length, ...ids.map((id) => id.length));
  return [3, idWidth, 22, 24, 6, 5, 7, 6, 8];
}

export function renderHeader(widths: readonly number[]): string {
  return COLUMNS.map((name, i) => name.padEnd(widths[i] ?? 0))
    .join("  ")
    .trimEnd();
}

export function renderRow(record: CaseRecord, index: number, widths: readonly number[]): string {
  return cells(record, index)
    .map((cell, i) =>
      i >= 5 && i <= 7 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0),
    )
    .join("  ")
    .trimEnd();
}

function criterionLine(entry: Summary["criteria"][number]): string {
  return `${entry.met ? "PASS" : "FAIL"}  ${entry.label}: ${entry.count}/${entry.total} (needs ${entry.needed}/${entry.total})`;
}

/** The summary as plain lines, for the console and the Markdown report alike. */
export function summaryLines(meta: ReportMeta, summary: Summary): string[] {
  const lines: string[] = [];
  lines.push(
    `Model: ${meta.model ?? "no answer"}${meta.modelDigest === null ? "" : ` (digest ${meta.modelDigest})`}; ` +
      `runtime ${meta.health.state}${meta.health.detail === undefined ? "" : `, ${meta.health.detail}`}`,
  );
  lines.push(
    `Prompt: ${meta.promptVersions.join(", ")}; tool use ${meta.runner.toolUse}, answers ${meta.runner.answerMode}; ` +
      `${meta.runner.callTimeoutMs / 1000} s per call, ${meta.runner.deadlineMs / 1000} s per job`,
  );
  lines.push(`Date: ${meta.date}; cases: ${meta.casesFile}`);
  for (const entry of summary.criteria) {
    lines.push(criterionLine(entry));
  }
  lines.push(
    `Valid JSON: ${summary.primaryValid}/${summary.cases} (${summary.validFirstTry} without the retry, ` +
      `${summary.unsure} asking a question)`,
  );
  if (summary.allValid !== summary.primaryValid) {
    lines.push(`Every job of the case valid: ${summary.allValid}/${summary.cases}`);
  }
  const failures = Object.entries(summary.failures);
  if (failures.length > 0) {
    lines.push(`Failures: ${failures.map(([code, count]) => `${code} ${count}`).join(", ")}`);
  }
  if (summary.toolUse !== null) {
    const tool = summary.toolUse;
    lines.push(
      `Tool calls (bookmaker): called ${tool.called}, injected ${tool.injected}, missed ${tool.missed} of ${tool.bookmakerRuns}; ` +
        `first reply already with the call ${tool.firstAnswerWithTool}/${tool.bookmakerRuns}`,
    );
  }
  lines.push(
    `Latency (job time with retries): p50 ${seconds(summary.latencyMs.p50)} s, p95 ${seconds(summary.latencyMs.p95)} s, max ${seconds(summary.latencyMs.max)} s`,
  );
  if (summary.withinPhotoBudget !== null) {
    lines.push(
      `Photo flow valid within ${PHOTO_JUDGEMENT_BUDGET_MS / 1000} s (inspector, then the bookmaker if it ran; a question from the inspector ends it): ${summary.withinPhotoBudget}/${summary.cases}`,
    );
  }
  if (summary.expectation !== null) {
    lines.push(
      `Matches the staged expectation: ${summary.expectation.matched}/${summary.expectation.total} (informational, not part of the target)`,
    );
  }
  lines.push(summary.targetMet ? "TARGET MET" : "TARGET MISSED");
  return lines;
}

/** The whole report as the console shows it. */
export function renderText(report: EvalReport): string {
  const widths = columnWidths(report.cases.map((record) => record.id));
  return [
    ...(report.mode === "fake" ? [FAKE_WARNING, ""] : []),
    renderHeader(widths),
    ...report.cases.map((record, index) => renderRow(record, index, widths)),
    "",
    ...summaryLines(report, report.summary),
  ].join("\n");
}

const escapeCell = (text: string): string => text.replace(/\|/g, "\\|");

export function renderMarkdown(report: EvalReport): string {
  const lines = [`# sib eval ${report.job}`, ""];
  if (report.mode === "fake") {
    lines.push(`> ${FAKE_WARNING}`, "");
  }
  lines.push(
    `**${report.summary.targetMet ? "Target met" : "Target missed"}**`,
    "",
    ...summaryLines(report, report.summary).map((line) => `- ${escapeCell(line)}`),
    "",
    `| ${COLUMNS.join(" | ")} |`,
    `| ${COLUMNS.map(() => "---").join(" | ")} |`,
    ...report.cases.map(
      (record, index) => `| ${cells(record, index).map(escapeCell).join(" | ")} |`,
    ),
    "",
  );
  const problems = report.cases.filter((record) => !record.valid);
  if (problems.length > 0) {
    lines.push("## Invalid cases", "");
    for (const record of problems) {
      for (const step of record.steps.filter((candidate) => !candidate.valid)) {
        lines.push(
          `- \`${record.id}\` (${step.job}): ${step.failure ?? "invalid"}${step.error === null ? "" : `: ${escapeCell(step.error)}`}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function serializeReport(report: EvalReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
