import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A fake local model runtime (Ollama or llama.cpp) on 127.0.0.1 that records what it is sent. */
export interface FakeRuntime {
  readonly port: number;
  readonly url: string;
  /** `METHOD /path` of every request, in order. */
  readonly urls: string[];
  /** The request bodies as text, in the same order. */
  readonly bodies: string[];
  close(): Promise<void>;
}

export async function startFakeRuntime(
  answer: (url: string, body: string) => unknown,
): Promise<FakeRuntime> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      urls.push(`${request.method ?? ""} ${request.url ?? ""}`);
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer(request.url ?? "", body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    urls,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
