import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_DIR } from "../src/server/config.js";
import { startServer, type RunningServer } from "../src/server/main.js";

import { LOCAL_ORIGIN, cookieHeaderFrom } from "./helpers.js";
import { syntheticWav } from "./support/audio.js";
import { multipartBody } from "./support/photos.js";

/*
 * main.ts on the real runtime path (not the fake model), against two fake local runtimes: an
 * Ollama and a llama.cpp, both on 127.0.0.1. Proves the voice job is routed to llama.cpp and
 * every other job to Ollama (AC-027.1, AC-027.2), with the wire format the clients assume.
 */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

interface Fake {
  readonly server: Server;
  readonly port: number;
  readonly bodies: string[];
  readonly urls: string[];
}

async function fakeRuntime(answer: (url: string) => unknown): Promise<Fake> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      urls.push(`${request.method ?? ""} ${request.url ?? ""}`);
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(answer(request.url ?? "")));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, bodies, urls };
}

const close = (fake: Fake | undefined): Promise<void> =>
  new Promise((resolve) => {
    fake?.server.closeAllConnections();
    fake?.server.close(() => {
      resolve();
    });
    if (fake === undefined) resolve();
  });

let dir: string;
let ollama: Fake | undefined;
let llama: Fake | undefined;
let running: RunningServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sib-voice-wiring-"));
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await close(ollama);
  await close(llama);
  rmSync(dir, { recursive: true, force: true });
});

function configure(models: Record<string, unknown>, flags: Record<string, boolean>): string {
  const configDir = join(dir, "config") + "/";
  mkdirSync(configDir);
  writeFileSync(`${configDir}flags.json`, JSON.stringify(flags));
  writeFileSync(`${configDir}models.json`, JSON.stringify(models));
  for (const name of ["server.example.json", "household.example.json"]) {
    copyFileSync(`${CONFIG_DIR}${name}`, `${configDir}${name}`);
  }
  return configDir;
}

describe("voice on the real runtime path", () => {
  it("AC-027.2: the note goes to llama.cpp on 127.0.0.1 and only the transcript text goes to Ollama", async () => {
    ollama = await fakeRuntime((url) =>
      url === "/api/tags"
        ? { models: [{ name: "gemma4:e4b", digest: "sha256:synthetic" }] }
        : {
            model: "gemma4:e4b",
            message: {
              role: "assistant",
              content: JSON.stringify({
                chores: [{ label: "water the plants", chore_type: "plants" }],
              }),
            },
          },
    );
    llama = await fakeRuntime((url) =>
      url === "/health"
        ? { status: "ok" }
        : {
            model: "gemma4-audio",
            choices: [
              {
                message: {
                  content: JSON.stringify({ status: "ok", transcript: "water the plants please" }),
                },
              },
            ],
          },
    );
    const configDir = configure(
      {
        primary: "e4b",
        ollama: { baseUrl: `http://127.0.0.1:${ollama.port}` },
        llamaCpp: { baseUrl: `http://127.0.0.1:${llama.port}` },
        models: { e4b: { tag: "gemma4:e4b" } },
      },
      { voice: true },
    );
    const port = await freePort();
    const notices: string[] = [];
    running = await startServer(
      { SIB_DATA_DIR: join(dir, "data"), SIB_FAKE_WEATHER: "1", SIB_PORT: String(port) },
      { configDir, output: (line) => notices.push(line) },
    );
    expect(notices.join("\n")).toContain(
      `Voice: llama.cpp audio at http://127.0.0.1:${llama.port} is up.`,
    );

    const { app, runtime } = running;
    const host = `localhost:${String(port)}`;
    const cookie = cookieHeaderFrom(
      await app.inject({
        method: "GET",
        url: `/pair?token=${runtime.store.issuePairingToken().token}`,
        headers: { host },
      }),
    );
    const wav = syntheticWav({ seconds: 0.5 });
    const body = multipartBody(wav, {
      fieldName: "audio",
      fileName: "note.wav",
      contentType: "audio/wav",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/voice/transcript",
      payload: body.payload,
      headers: {
        host,
        origin: LOCAL_ORIGIN.replace("8787", String(port)),
        cookie,
        ...body.headers,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ transcript: string }>().transcript).toBe("water the plants please");

    // llama.cpp got the audio, base64, in an input_audio part of the chat request.
    const audioCall = llama.bodies.find((text) => text.includes("input_audio"));
    expect(audioCall).toBeDefined();
    expect(audioCall).toContain(wav.toString("base64"));
    expect(llama.urls).toContain("POST /v1/chat/completions");
    // Ollama got the transcript as text and never the sound.
    const listenerCall = ollama.bodies.find((text) => text.includes("water the plants please"));
    expect(listenerCall).toBeDefined();
    expect(ollama.bodies.some((text) => text.includes(wav.toString("base64").slice(0, 64)))).toBe(
      false,
    );
    expect(ollama.bodies.some((text) => text.includes("input_audio"))).toBe(false);
  });

  it("AC-027.2: a llamaCpp.baseUrl that is not on this laptop stops the app from starting", async () => {
    ollama = await fakeRuntime(() => ({ models: [] }));
    const configDir = configure(
      {
        primary: "e4b",
        ollama: { baseUrl: `http://127.0.0.1:${ollama.port}` },
        llamaCpp: { baseUrl: "http://192.168.1.50:8080" },
        models: { e4b: { tag: "gemma4:e4b" } },
      },
      { voice: true },
    );
    await expect(
      startServer(
        {
          SIB_DATA_DIR: join(dir, "data"),
          SIB_FAKE_WEATHER: "1",
          SIB_PORT: String(await freePort()),
        },
        { configDir, output: () => undefined },
      ),
    ).rejects.toThrow(/llama\.cpp must be an http URL on 127\.0\.0\.1/);
  });

  it("with the voice flag off no llama.cpp client is built and nothing is asked of it", async () => {
    ollama = await fakeRuntime((url) =>
      url === "/api/tags" ? { models: [{ name: "gemma4:e4b" }] } : { message: { content: "{}" } },
    );
    llama = await fakeRuntime(() => ({}));
    const configDir = configure(
      {
        primary: "e4b",
        ollama: { baseUrl: `http://127.0.0.1:${ollama.port}` },
        llamaCpp: { baseUrl: `http://127.0.0.1:${llama.port}` },
        models: { e4b: { tag: "gemma4:e4b" } },
      },
      { voice: false },
    );
    const notices: string[] = [];
    running = await startServer(
      {
        SIB_DATA_DIR: join(dir, "data"),
        SIB_FAKE_WEATHER: "1",
        SIB_PORT: String(await freePort()),
      },
      { configDir, output: (line) => notices.push(line) },
    );
    expect(notices.join("\n")).not.toContain("Voice");
    expect(llama.urls).toEqual([]);
  });
});
