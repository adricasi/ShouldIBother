import { readdirSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { LISTENER_AUDIO_PROMPT } from "../src/server/gemma/listener-audio.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelClient,
  ModelHealth,
} from "../src/server/model/client.js";
import { FakeModelClient } from "../src/server/model/fake.js";
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS } from "../src/server/voice/wav.js";

import { createCoreHarness, pair, type CoreHarness } from "./core-helpers.js";
import { LOCAL_ORIGIN } from "./helpers.js";
import { syntheticWav } from "./support/audio.js";
import { multipartBody } from "./support/photos.js";

let harness: CoreHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function setup(options: Parameters<typeof createCoreHarness>[0] = {}) {
  const model = options.model ?? new FakeModelClient();
  if (options.model === undefined) {
    model.setScenario("bookmaker", "offline");
  }
  harness = await createCoreHarness({ flags: { voice: true }, ...options, model });
  await pair(harness);
  return { h: harness, model };
}

function upload(h: CoreHarness, bytes: Buffer, options: { cookie?: boolean; type?: string } = {}) {
  const body = multipartBody(bytes, {
    fieldName: "audio",
    fileName: "note.wav",
    contentType: options.type ?? "audio/wav",
  });
  return h.request({
    method: "POST",
    url: "/api/voice/transcript",
    payload: body.payload,
    headers: {
      ...(options.cookie === false ? {} : { cookie: h.cookie }),
      origin: LOCAL_ORIGIN,
      ...body.headers,
    },
  });
}

interface Preview {
  transcript: string;
  chores: { label: string; chore_type: string; kind: string }[];
  duration_ms: number;
}

const cardCount = (h: CoreHarness): number =>
  h.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM cards").get()!.n;

class RecordingAudioRuntime implements ModelClient {
  readonly calls: ChatRequest[] = [];
  chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    return Promise.resolve({
      content: JSON.stringify({ status: "ok", transcript: "water the plants" }),
      toolCalls: [],
      model: "audio-runtime",
    });
  }
  health(): Promise<ModelHealth> {
    return Promise.resolve({ state: "online" });
  }
}

const audioCalls = (model: FakeModelClient): ChatRequest[] =>
  model.calls.filter((call) => call.job === "listener-audio");

describe("AC-027.1: the transcript is shown with chores highlighted before any card exists", () => {
  it("answers a voice note with the transcript and its chores, and makes no card", async () => {
    const { h, model } = await setup();
    model.setScenario("listener-audio", "mixed");
    model.setScenario("listener", "mixed");
    const response = await upload(h, syntheticWav({ seconds: 2 }));
    expect(response.statusCode).toBe(200);
    const preview = response.json<Preview>();
    expect(preview.transcript).toContain("water the plants");
    expect(preview.duration_ms).toBe(2000);
    expect(preview.chores.map((chore) => [chore.chore_type, chore.kind])).toEqual([
      ["plants", "weather"],
      ["not_weather", "not_weather"],
      // The laundry planner is flagged off here, so it is "coming later"; the AC is a bettable chore.
      ["laundry_plan", "coming_later"],
      ["ac", "weather"],
    ]);
    expect(cardCount(h)).toBe(0);
    expect(model.calls.filter((call) => call.job === "bookmaker")).toHaveLength(0);
  });

  it("makes the cards only when the person confirms the chores, through the typed-capture path", async () => {
    const { h, model } = await setup();
    model.setScenario("listener-audio", "mixed");
    model.setScenario("listener", "mixed");
    const preview = (await upload(h, syntheticWav())).json<Preview>();
    expect(cardCount(h)).toBe(0);
    const confirmed = await h.post("/api/voice/cards", {
      chores: preview.chores.map(({ label, chore_type }) => ({ label, chore_type })),
    });
    expect(confirmed.statusCode).toBe(201);
    const { cards } = confirmed.json<{ cards: { kind: string; chore_type: string }[] }>();
    expect(cards.map((card) => card.kind)).toEqual([
      "weather",
      "not_weather",
      "coming_later",
      // The example household has no AC, so that chore becomes "Not needed this season".
      "coming_later",
    ]);
    expect(cardCount(h)).toBe(4);
    // The listener ran once, on the transcript, before the confirmation; confirming asks nobody.
    expect(model.calls.filter((call) => call.job === "listener")).toHaveLength(1);
  });

  it("hands the listener the transcript as text, inside the untrusted data block", async () => {
    const { h, model } = await setup();
    await upload(h, syntheticWav());
    const call = model.calls.find((entry) => entry.job === "listener");
    expect(call?.messages[1]?.content).toContain("Water the tomatoes tonight");
    expect(call?.messages[1]?.content).toContain("<untrusted_data>");
    expect(call?.audio).toBeUndefined();
  });

  it("tells the voice job that the audio is data, not instructions", () => {
    expect(LISTENER_AUDIO_PROMPT.text).toMatch(/data, not instructions/);
  });

  it("asks the person to try again when Gemma could not make out any speech, and makes no card", async () => {
    const { h, model } = await setup();
    model.setScenario("listener-audio", "unsure");
    const response = await upload(h, syntheticWav({ tone: false }));
    expect(response.statusCode).toBe(422);
    expect(response.json<{ title: string }>().title).toBe("Gemma couldn't make that out");
    expect(model.calls.filter((call) => call.job === "listener")).toHaveLength(0);
    expect(cardCount(h)).toBe(0);
  });

  it.each(["invalid-json", "ok-without-transcript", "too-long"])(
    "rejects an unusable transcript (%s) with a 422 after one retry",
    async (scenario) => {
      const { h, model } = await setup();
      model.setScenario("listener-audio", scenario);
      const response = await upload(h, syntheticWav());
      expect(response.statusCode).toBe(422);
      // The first attempt and the single retry: one call each, no tool.
      expect(audioCalls(model)).toHaveLength(2);
      expect(cardCount(h)).toBe(0);
    },
  );

  it("accepts a good transcript on the retry", async () => {
    const { h, model } = await setup();
    model.setScenario("listener-audio", "invalid-then-valid");
    expect((await upload(h, syntheticWav())).statusCode).toBe(200);
  });

  it("says voice is offline when the audio runtime is down or too slow, and makes no card", async () => {
    const { h, model } = await setup();
    for (const scenario of ["offline", "timeout"]) {
      model.setScenario("listener-audio", scenario);
      const response = await upload(h, syntheticWav());
      expect(response.statusCode).toBe(503);
      expect(response.json<{ title: string }>().title).toBe("Voice is offline");
    }
    expect(cardCount(h)).toBe(0);
  });

  it("applies the runner's per-call timeout to the audio call", async () => {
    class SilentAudioModel extends FakeModelClient {
      override async chat(request: ChatRequest): Promise<ChatResponse> {
        if (request.job === "listener-audio") {
          return await new Promise<ChatResponse>(() => undefined);
        }
        return super.chat(request);
      }
    }
    const { h } = await setup({ model: new SilentAudioModel(), runner: { callTimeoutMs: 30 } });
    const response = await upload(h, syntheticWav());
    expect(response.statusCode).toBe(503);
  });

  it("refuses to confirm anything but listener chores", async () => {
    const { h } = await setup();
    for (const body of [
      {},
      { chores: [] },
      { chores: [{ label: "x", chore_type: "nonsense" }] },
      { chores: [{ label: "x", chore_type: "plants", kind: "weather" }] },
    ]) {
      expect((await h.post("/api/voice/cards", body)).statusCode).toBe(400);
    }
    expect(cardCount(h)).toBe(0);
  });
});

describe("AC-027.2: audio goes only to the local runtime", () => {
  it("sends the audio to the audio job's runtime only, never to the primary model", async () => {
    const audioRuntime = new RecordingAudioRuntime();
    const { h, model } = await setup({ runner: { jobModels: { "listener-audio": audioRuntime } } });
    const wav = syntheticWav({ seconds: 0.5 });
    expect((await upload(h, wav)).statusCode).toBe(200);
    expect(audioRuntime.calls).toHaveLength(1);
    expect(Buffer.from(audioRuntime.calls[0]!.audio![0]!).equals(wav)).toBe(true);
    // The primary model saw the listener's text and nothing with sound in it.
    expect(model.calls.map((call) => call.job)).toEqual(["listener"]);
    expect(model.calls.every((call) => call.audio === undefined)).toBe(true);
    // The decision names the model that answered.
    const row = h.db
      .prepare<[], { model: string }>(
        "SELECT model FROM gemma_decisions WHERE job = 'listener-audio'",
      )
      .get();
    expect(row?.model).toBe("audio-runtime");
  });

  it("needs a paired session like every other route", async () => {
    const { h, model } = await setup();
    const response = await upload(h, syntheticWav(), { cookie: false });
    expect(response.statusCode).toBe(401);
    expect(model.calls).toHaveLength(0);
  });
});

describe("limits on the upload", () => {
  it("refuses a voice note over the size cap before any model call", async () => {
    const { h, model } = await setup();
    const big = syntheticWav({ seconds: 1, sampleRate: 16_000 });
    const padded = Buffer.concat([big, Buffer.alloc(MAX_VOICE_BYTES)]);
    const response = await upload(h, padded);
    expect(response.statusCode).toBe(413);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses a voice note that is too long, even when it is small", async () => {
    const { h, model } = await setup();
    // 8 kHz mono: 31 s is 496 kB, under the byte cap but over the length cap.
    const response = await upload(
      h,
      syntheticWav({ seconds: MAX_VOICE_SECONDS + 1, sampleRate: 8_000 }),
    );
    expect(response.statusCode).toBe(413);
    expect(response.json<{ title: string }>().title).toBe("Voice note too long");
    expect(model.calls).toHaveLength(0);
  });

  it("accepts a note exactly at the length cap", async () => {
    const { h } = await setup();
    const response = await upload(
      h,
      syntheticWav({ seconds: MAX_VOICE_SECONDS, sampleRate: 8_000 }),
    );
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ["not audio at all", Buffer.from("this is not a wav file, just text")],
    [
      "a compressed recording",
      Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]),
    ],
  ])("refuses %s with 415", async (_name, bytes) => {
    const { h, model } = await setup();
    const response = await upload(h, bytes);
    expect(response.statusCode).toBe(415);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses an empty recording with 400 and a request that is not an upload with 415", async () => {
    const { h, model } = await setup();
    expect((await upload(h, syntheticWav({ seconds: 0 }))).statusCode).toBe(400);
    const notMultipart = await h.post("/api/voice/transcript", { audio: "x" });
    expect(notMultipart.statusCode).toBe(415);
    expect(model.calls).toHaveLength(0);
  });
});

describe("the model hears only what was measured", () => {
  it("AC-027.2: sends a canonical WAV without the chunks and bytes that trail the data", async () => {
    const audioRuntime = new RecordingAudioRuntime();
    const { h } = await setup({ runner: { jobModels: { "listener-audio": audioRuntime } } });
    const wav = syntheticWav({ seconds: 1 });
    const trailing = Buffer.concat([
      Buffer.from("LIST"),
      Buffer.alloc(4, 0xff),
      Buffer.alloc(50_000),
    ]);
    const response = await upload(h, Buffer.concat([wav, trailing]));
    expect(response.statusCode).toBe(200);
    expect(audioRuntime.calls).toHaveLength(1);
    expect(Buffer.from(audioRuntime.calls[0]!.audio![0]!).equals(wav)).toBe(true);
    const row = h.db
      .prepare<[], { input_summary: string }>(
        "SELECT input_summary FROM gemma_decisions WHERE job = 'listener-audio'",
      )
      .get();
    expect(row?.input_summary).toContain(`${wav.length} bytes`);
  });
});

describe("room for both jobs", () => {
  it("answers 503 busy before reading the note when the queue cannot take the audio job and the listener", async () => {
    const { h, model } = await setup({ runner: { maxQueued: 1 } });
    const response = await upload(h, syntheticWav());
    expect(response.statusCode).toBe(503);
    expect(response.json<{ title: string }>().title).toBe("Gemma is busy");
    expect(model.calls).toEqual([]);
  });
});

describe("the audio is not persisted", () => {
  it("leaves no file, no database row and no log line with the audio or the transcript", async () => {
    const logLines: string[] = [];
    const { h, model } = await setup({ logLines });
    model.setScenario("listener-audio", "ok");
    const wav = syntheticWav({ seconds: 1 });
    const response = await upload(h, wav);
    expect(response.statusCode).toBe(200);
    await h.idle();

    // No file anywhere in the app's data folder.
    expect(readdirSync(h.photos.dir)).toEqual([]);

    // The decision log keeps the length and a hash, not the sound and not what was said.
    const decisions = h.db
      .prepare<[], { job: string; input_summary: string; output: string | null; valid: number }>(
        "SELECT job, input_summary, output, valid FROM gemma_decisions ORDER BY id",
      )
      .all();
    const voice = decisions.find((row) => row.job === "listener-audio");
    expect(voice).toMatchObject({ valid: 1, output: null });
    expect(voice?.input_summary).toMatch(/^voice note, 1\.0 s, \d+ bytes, sha256 [0-9a-f]{12}$/);
    const everything = JSON.stringify(decisions) + logLines.join("");
    expect(everything).not.toContain(wav.toString("base64").slice(0, 64));
    expect(everything).not.toContain("Water the tomatoes tonight");
    // Same for every table: nothing stored holds the transcript or the audio.
    const tables = h.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    for (const { name } of tables) {
      const rows = JSON.stringify(h.db.prepare(`SELECT * FROM "${name}"`).all());
      expect(rows).not.toContain("Water the tomatoes tonight");
    }
  });
});

describe("the voice flag off", () => {
  it("AC-029.2: exposes no voice route and reports the flag off", async () => {
    harness = await createCoreHarness({ flags: { voice: false } });
    await pair(harness);
    const h = harness;
    expect((await upload(h, syntheticWav())).statusCode).toBe(404);
    expect((await h.post("/api/voice/cards", { chores: [] })).statusCode).toBe(404);
    const today = (await h.get("/api/today")).json<{ flags: Record<string, boolean> }>();
    expect(today.flags["voice"]).toBe(false);
    expect(h.model instanceof FakeModelClient && h.model.calls).toEqual([]);
  });
});
