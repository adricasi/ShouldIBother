import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `prompts/<job>.v<n>.md`, versioned files (AGENTS.md, Project rules). */
export const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts/", import.meta.url));

export interface Prompt {
  /** Recorded on every decision and bet, e.g. `judge.v1`. */
  readonly version: string;
  readonly text: string;
}

export function loadPrompt(job: string, version: number, dir: string = PROMPTS_DIR): Prompt {
  const name = `${job}.v${version}`;
  return { version: name, text: readFileSync(join(dir, `${name}.md`), "utf8") };
}
