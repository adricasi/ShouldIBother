/**
 * Wraps data for a prompt: everything between the delimiters is untrusted data, never
 * instructions (design.md, Gemma jobs). `<` is written as `<`, which is the same JSON string
 * but cannot spell the closing delimiter, so typed text cannot end the block early.
 */
export function untrustedBlock(data: unknown): string {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c");
  return `<untrusted_data>\n${json}\n</untrusted_data>`;
}
