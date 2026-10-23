import { ModelUnavailableError } from "./client.js";

/** No answer from a local runtime is bigger than this; a larger body is refused unread. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/** Reads a response body as text, giving up when it grows past `maxBytes`. */
export async function readLimited(
  response: Response,
  maxBytes: number,
  runtime: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new ModelUnavailableError(`${runtime} sent an answer that is too large`);
  }
  if (response.body === null) {
    return "";
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ModelUnavailableError(`${runtime} sent an answer that is too large`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
