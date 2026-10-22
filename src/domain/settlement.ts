/** No answer this long after the settle time: the judge settles from the weather record (AC-008.7). */
export const ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** After a failed try the scheduler waits this long before asking Gemma about the same bet again. */
export const GEMMA_RETRY_MS = 2 * 60 * 1000;
/** The judge may ask this many questions; after that it has to decide (AC-008.5). */
export const MAX_QUESTIONS = 2;
