/** Literal loopback addresses only: a name like `localhost` can be pointed elsewhere. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]"]);

/**
 * The origin of a local model runtime's URL, or undefined when it is not plain http on a literal
 * loopback address. Ollama and llama.cpp stay on this laptop (NFR-001, AC-027.2): config and the
 * clients both use this one check, so a wrong host fails at load and again at construction.
 */
export function loopbackOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
      return url.origin;
    }
  } catch {
    // not a URL: reported by the caller
  }
  return undefined;
}
