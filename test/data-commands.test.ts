import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deletePhotosCommand, exportCommand, type Confirm } from "../src/server/data-commands.js";
import { loadRuntime, type Runtime } from "../src/server/runtime.js";
import { FAKE_WEATHER_PROFILES } from "../src/server/weather/fake.js";

import { createCoreHarness, pair, uploadPhoto } from "./core-helpers.js";
import { multipartBody, syntheticPhoto } from "./support/photos.js";
import { LOCAL_ORIGIN } from "./helpers.js";
import { seedBet, tap } from "./support/settle.js";

let root: string;
let dataDir: string;
let configDir: string;
const printed: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sib-data-"));
  dataDir = join(root, "data");
  configDir = `${root}/config/`;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(`${configDir}server.example.json`, JSON.stringify({ port: 8787 }));
  printed.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const print = (text: string): void => {
  printed.push(text);
};
const answering =
  (answer: string): Confirm =>
  (_question, expected) =>
    Promise.resolve(answer === expected);

const runtime = (): Runtime => loadRuntime({ SIB_DATA_DIR: dataDir }, configDir);

/** A data folder as the live week leaves it: a photo bet with a before photo, a tap bet, a do-it. */
async function liveWeek(): Promise<{ photoBet: number; tapBet: number }> {
  const harness = await createCoreHarness({
    dbPath: join(dataDir, "sib.db"),
    photosDir: join(dataDir, "photos"),
    weatherProfile: FAKE_WEATHER_PROFILES.rainy,
  });
  try {
    await pair(harness);
    const card = (await harness.post("/api/cards/quick", { chore_type: "plants" })).json<{
      id: number;
    }>();
    await harness.idle(); // the card's own odds first, or the photo is refused with 409
    expect((await uploadPhoto(harness, card.id, await syntheticPhoto())).statusCode).toBe(201);
    await harness.idle();
    const photoBet = seedBet(harness, { band: 3 });
    const after = multipartBody(await syntheticPhoto({ shade: 140 }));
    const settled = await harness.request({
      method: "POST",
      url: `/api/bets/${photoBet}/settle`,
      payload: after.payload,
      headers: { cookie: harness.cookie, origin: LOCAL_ORIGIN, ...after.headers },
    });
    expect(settled.statusCode).toBe(200);
    const tapBet = seedBet(harness, { band: 1 });
    await tap(harness, tapBet, "moist");
    seedBet(harness, { kind: "do_it", status: "open", settleOffsetMs: 3_600_000 });
    return { photoBet, tapBet };
  } finally {
    await harness.close();
  }
}

const photoFiles = (): string[] => readdirSync(join(dataDir, "photos"));
const count = (rt: Runtime, table: string): number =>
  rt.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;

describe("sib delete-photos (AC-015.3)", () => {
  it("AC-015.3: asks first; anything but the confirmation word deletes nothing", async () => {
    await liveWeek();
    const before = photoFiles();
    expect(before.length).toBe(2);
    for (const answer of ["", "y", "no", "YES!"]) {
      const rt = runtime();
      expect(
        await deletePhotosCommand(rt, { allData: false }, { confirm: answering(answer), print }),
      ).toBe(false);
    }
    expect(photoFiles()).toEqual(before);
    expect(printed.at(-1)).toContain("Nothing was deleted");
  });

  it("AC-015.3, AC-015.2: removes every photo file and row, the quotes and decisions that used them, and keeps bets and points", async () => {
    await liveWeek();
    // A file no row names (a crash left it) goes too.
    writeFileSync(join(dataDir, "photos", "00000000-0000-4000-8000-000000000000.jpg"), "x");
    const rt = runtime();
    const betsBefore = count(rt, "bets");
    const pointsBefore = rt.db
      .prepare<[], { s: number }>("SELECT SUM(points) AS s FROM settlements")
      .get()!.s;
    expect(count(rt, "photos")).toBe(2);
    expect(
      await deletePhotosCommand(rt, { allData: false }, { confirm: answering("yes"), print }),
    ).toBe(true);
    expect(printed).toContain("Deleted 2 photos.");
    expect(photoFiles()).toEqual([]);

    const after = runtime();
    expect(count(after, "photos")).toBe(0);
    expect(count(after, "bets")).toBe(betsBefore);
    expect(
      after.db.prepare<[], { s: number }>("SELECT SUM(points) AS s FROM settlements").get()!.s,
    ).toBe(pointsBefore);
    expect(
      after.db
        .prepare("SELECT COUNT(*) AS n FROM gemma_decisions WHERE photo_id IS NOT NULL")
        .get(),
    ).toEqual({ n: 0 });
    // The judge read the photo bet's photos; the tap bet's judge decision never saw one.
    expect(
      after.db.prepare("SELECT bet_id FROM gemma_decisions WHERE job = 'judge'").all(),
    ).toHaveLength(1);
    expect(
      after.db.prepare("SELECT COUNT(*) AS n FROM quotes WHERE photo_id IS NOT NULL").get(),
    ).toEqual({
      n: 0,
    });
    after.db.close();
  });

  it("AC-015.3: --all-data asks for a stronger confirmation, then removes the database, WAL files and photos, and nothing else", async () => {
    await liveWeek();
    mkdirSync(join(dataDir, "logs"));
    writeFileSync(join(dataDir, "logs", "app.json"), "{}");
    writeFileSync(join(dataDir, "app.log"), "{}");
    writeFileSync(join(dataDir, "notes.txt"), "mine");

    // "yes" is not enough for --all-data.
    expect(
      await deletePhotosCommand(runtime(), { allData: true }, { confirm: answering("yes"), print }),
    ).toBe(false);
    expect(existsSync(join(dataDir, "sib.db"))).toBe(true);
    expect(photoFiles().length).toBe(2);

    expect(
      await deletePhotosCommand(
        runtime(),
        { allData: true },
        { confirm: answering("delete everything"), print },
      ),
    ).toBe(true);
    // Only what the app owns goes: logs go to stdout, and other files in the folder are not ours.
    expect(readdirSync(dataDir).sort()).toEqual(["app.log", "logs", "notes.txt"]);
    expect(readFileSync(join(dataDir, "notes.txt"), "utf8")).toBe("mine");
    expect(printed.at(-1)).toContain("weather cache");
  });

  it("AC-015.3: the --all-data prompt says what stays: household.json is outside the data folder", async () => {
    await liveWeek();
    const questions: string[] = [];
    await deletePhotosCommand(
      runtime(),
      { allData: true },
      {
        confirm: (question) => {
          questions.push(question);
          return Promise.resolve(false);
        },
        print,
      },
    );
    expect(questions[0]).toContain("config/household.json");
    expect(questions[0]).toContain("onboarding");
    expect(questions[0]).toContain("kept");
    expect(questions[0]).toContain("delete everything");
  });

  it("AC-015.3: the freed pages are overwritten: text of a deleted decision is not left in the database files", async () => {
    await liveWeek();
    const rt = runtime();
    const marker = "ZZ-planted-marker-ZZ";
    rt.db
      .prepare(
        "INSERT INTO gemma_decisions (job, bet_id, photo_id, model, prompt_version, input_summary, output, valid, latency_ms, created_at) SELECT 'judge', NULL, id, 'm', 'judge.v2', ?, ?, 1, 1, 1 FROM photos LIMIT 1",
      )
      .run(marker, marker);
    expect(readFileSync(join(dataDir, "sib.db"), "latin1") + "").toBeDefined();
    await deletePhotosCommand(rt, { allData: false }, { confirm: answering("yes"), print });
    for (const name of readdirSync(dataDir).filter((file) => file.startsWith("sib.db"))) {
      expect(readFileSync(join(dataDir, name)).includes(Buffer.from(marker))).toBe(false);
    }
  });
});

describe("sib export <dir> (AC-015.4)", () => {
  it("AC-015.4: writes bets, decisions, verdicts, answers and totals as JSON plus the photo files", async () => {
    const { photoBet, tapBet } = await liveWeek();
    const target = join(root, "out");
    exportCommand(runtime(), target, print, Date.UTC(2026, 9, 22, 12, 0));

    expect(statSync(target).mode & 0o777).toBe(0o700);
    const files = readdirSync(join(target, "photos"));
    expect(files.length).toBe(2);
    const document = JSON.parse(readFileSync(join(target, "export.json"), "utf8")) as {
      version: number;
      bets: { id: number; savings_snapshot: { water_l: number } | null }[];
      verdicts: { bet_id: number; verdict: string; points: number; weather: { digest: object } }[];
      decisions: { job: string }[];
      answers: { bet_id: number; evidence: string }[];
      photos_dir: string;
      photos: { file: string; role: string }[];
      totals: { points: number; savings: { wins: number; water_l: number } };
    };
    expect(document.version).toBe(1);
    expect(document.bets.map((bet) => bet.id)).toEqual(expect.arrayContaining([photoBet, tapBet]));
    expect(document.bets.find((bet) => bet.id === photoBet)?.savings_snapshot?.water_l).toBe(4);
    expect(
      document.verdicts.map((verdict) => [verdict.bet_id, verdict.verdict, verdict.points]),
    ).toEqual([
      [photoBet, "win", 30],
      [tapBet, "win", 33],
    ]);
    expect(document.verdicts[0]?.weather.digest).toBeDefined();
    expect(document.answers.map((answer) => answer.evidence)).toEqual(["photo", "tap"]);
    expect(document.decisions.some((decision) => decision.job === "judge")).toBe(true);
    expect(document.photos.map((photo) => photo.role).sort()).toEqual(["after", "before"]);
    for (const photo of document.photos) {
      // A bare file name; the files are in the export's photos folder.
      expect(photo.file).toMatch(/^[0-9a-f-]{36}\.jpg$/);
      expect(existsSync(join(target, document.photos_dir, photo.file))).toBe(true);
    }
    expect(document.totals).toMatchObject({ points: 63, savings: { wins: 2, water_l: 8 } });
    // Sessions and tokens are not household data.
    expect(JSON.stringify(document)).not.toMatch(/id_hash|token_hash/);
    expect(printed.at(-1)).toContain("3 bets");
  });

  it("AC-015.4: refuses a folder that already has files", async () => {
    await liveWeek();
    const target = join(root, "busy");
    mkdirSync(target);
    writeFileSync(join(target, "something.txt"), "x");
    expect(() => {
      exportCommand(runtime(), target, print);
    }).toThrow(/not a new or empty folder/);
  });
});

describe("the app must not be running (C5, Sec-S1)", () => {
  it.each([
    ["delete-photos", false],
    ["delete-photos --all-data", true],
  ])(
    "%s refuses while another connection has the database open, and deletes nothing",
    async (_name, allData) => {
      await liveWeek();
      const app = runtime(); // stands in for the running app
      const before = readdirSync(join(dataDir, "photos"));
      await expect(
        deletePhotosCommand(
          runtime(),
          { allData },
          { confirm: answering("delete everything"), print },
        ),
      ).rejects.toThrow(/Stop the app first/);
      expect(readdirSync(join(dataDir, "photos"))).toEqual(before);
      expect(existsSync(join(dataDir, "sib.db"))).toBe(true);
      expect(count(app, "photos")).toBe(2);
      app.db.close();
    },
  );

  it("export refuses while another connection has the database open, and writes nothing", async () => {
    await liveWeek();
    const app = runtime();
    const target = join(root, "out");
    expect(() => {
      exportCommand(runtime(), target, print);
    }).toThrow(/Stop the app first/);
    expect(existsSync(target)).toBe(false);
    app.db.close();
  });

  it("works again once the app has stopped", async () => {
    await liveWeek();
    const app = runtime();
    app.db.close();
    expect(
      await deletePhotosCommand(
        runtime(),
        { allData: false },
        { confirm: answering("yes"), print },
      ),
    ).toBe(true);
  });
});

describe("the export folder (Sec-S3)", () => {
  it("refuses a symlink as the target, also to an empty folder, and writes nothing through it", async () => {
    await liveWeek();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const link = join(root, "link");
    symlinkSync(elsewhere, link);
    expect(() => {
      exportCommand(runtime(), link, print);
    }).toThrow(/links are refused/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("creates the folder owner-only, never overwrites a file, and says how many photo files were missing", async () => {
    await liveWeek();
    const photo = readdirSync(join(dataDir, "photos"))[0]!;
    rmSync(join(dataDir, "photos", photo));
    const target = join(root, "fresh", "out");
    exportCommand(runtime(), target, print);
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(statSync(join(target, "export.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(target, "photos")).length).toBe(1);
    expect(printed.join("\n")).toContain("1 photo file was missing");
    // Exporting again into the same, now non-empty, folder is refused.
    expect(() => {
      exportCommand(runtime(), target, print);
    }).toThrow(/not a new or empty folder/);
  });
});
