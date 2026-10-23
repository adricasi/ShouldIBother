export type ChoreKind = "weather" | "coming_later" | "not_weather";

export interface HighlightChore {
  readonly label: string;
  readonly item?: string | undefined;
  readonly kind: ChoreKind;
}

export interface Segment {
  readonly text: string;
  /** Absent: words that are no chore (the "I have to" and "and" of the sentence). */
  readonly kind?: ChoreKind;
}

/** First case-insensitive hit of `needle` in `text` that does not overlap a taken range. */
function findFree(text: string, needle: string, taken: readonly [number, number][]) {
  const lower = text.toLowerCase();
  const wanted = needle.trim().toLowerCase();
  if (wanted === "") {
    return undefined;
  }
  let from = 0;
  for (;;) {
    const at = lower.indexOf(wanted, from);
    if (at === -1) {
      return undefined;
    }
    const end = at + wanted.length;
    if (!taken.some(([start, stop]) => at < stop && end > start)) {
      return [at, end] as const;
    }
    from = at + 1;
  }
}

/**
 * Splits a transcript into runs for display, marking where the listener's chores were said
 * (mockup 03: weather chores green, others grey). The listener returns labels, not positions, so
 * a chore is found by its label, then by its item; a chore whose words are not in the transcript
 * (Gemma paraphrased) is simply not marked: the parsed list below is the source of truth.
 */
export function highlightSegments(
  transcript: string,
  chores: readonly HighlightChore[],
): Segment[] {
  const taken: [number, number][] = [];
  const marks: { start: number; end: number; kind: ChoreKind }[] = [];
  for (const chore of chores) {
    const hit =
      findFree(transcript, chore.label, taken) ??
      (chore.item === undefined ? undefined : findFree(transcript, chore.item, taken));
    if (hit !== undefined) {
      taken.push([hit[0], hit[1]]);
      marks.push({ start: hit[0], end: hit[1], kind: chore.kind });
    }
  }
  marks.sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) {
      segments.push({ text: transcript.slice(cursor, mark.start) });
    }
    segments.push({ text: transcript.slice(mark.start, mark.end), kind: mark.kind });
    cursor = mark.end;
  }
  if (cursor < transcript.length) {
    segments.push({ text: transcript.slice(cursor) });
  }
  return segments;
}
