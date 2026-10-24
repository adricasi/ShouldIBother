import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CONFIG_DIR } from "../src/server/config.js";
import { loadFlagPresets } from "../src/server/flag-presets.js";
import { FLAG_NAMES, loadFlags } from "../src/server/flags.js";
import { flagsCommand } from "../src/server/flags-command.js";

let configDir = "";
let output: string[] = [];

const print = (text: string): void => {
  output.push(text);
};
const run = (...args: string[]): number => flagsCommand(args, print, configDir);
const flagsFile = (): string => readFileSync(`${configDir}flags.json`, "utf8");
const current = () => loadFlags(`${configDir}flags.json`);

beforeEach(() => {
  configDir = `${mkdtempSync(join(tmpdir(), "sib-flags-"))}/`;
  copyFileSync(`${CONFIG_DIR}flags.json`, `${configDir}flags.json`);
  copyFileSync(`${CONFIG_DIR}flags.presets.json`, `${configDir}flags.presets.json`);
  output = [];
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("sib flags (AC-029.3)", () => {
  it("AC-029.3: lists every flag with its state", () => {
    expect(run()).toBe(0);
    expect(run("list")).toBe(0);
    for (const name of FLAG_NAMES) {
      expect(output[0]).toMatch(new RegExp(`^${name} +off$`, "m"));
    }
  });

  it("AC-029.3: turns named flags on and off in the file", () => {
    expect(run("on", "score", "ranks")).toBe(0);
    expect(current().score).toBe(true);
    expect(current().ranks).toBe(true);
    expect(current().heater).toBe(false);
    expect(output.join("\n")).toContain("Restart the app to apply");
    expect(run("off", "score")).toBe(0);
    expect(current().score).toBe(false);
    expect(current().ranks).toBe(true);
  });

  it("AC-029.3: refuses an unknown flag and changes nothing", () => {
    const before = flagsFile();
    expect(run("on", "score", "teleport")).toBe(1);
    expect(output.join("\n")).toContain("Unknown flag: teleport");
    expect(run("preset", "presentation", "teleport")).toBe(1);
    expect(run("preset", "weekend")).toBe(1);
    expect(run("on")).toBe(1);
    expect(run("dance")).toBe(1);
    expect(flagsFile()).toBe(before);
  });

  it("AC-029.3: the presentation preset turns on everything except voice and finetunedBookmaker", () => {
    expect(run("preset", "presentation")).toBe(0);
    const flags = current();
    for (const name of FLAG_NAMES) {
      expect(flags[name]).toBe(name !== "voice" && name !== "finetunedBookmaker");
    }
  });

  it("AC-029.3: the preset leaves voice and finetunedBookmaker as they are unless named", () => {
    run("on", "voice");
    expect(run("preset", "presentation")).toBe(0);
    expect(current().voice).toBe(true);
    expect(current().finetunedBookmaker).toBe(false);
    expect(run("preset", "presentation", "finetunedBookmaker")).toBe(0);
    expect(current().finetunedBookmaker).toBe(true);
  });

  it("AC-029.3: a preset turns on exactly the flags the presets file lists", () => {
    writeFileSync(`${configDir}flags.presets.json`, '{ "small": ["score", "ranks"] }');
    expect(run("preset", "small")).toBe(0);
    const flags = current();
    expect(FLAG_NAMES.filter((name) => flags[name])).toEqual(["score", "ranks"]);
    expect(run("preset", "presentation")).toBe(1);
    expect(output.join("\n")).toContain("Known presets: small");
  });

  it("AC-029.3: a presets file with an unknown flag is an error and changes nothing", () => {
    writeFileSync(`${configDir}flags.presets.json`, '{ "presentation": ["score", "teleport"] }');
    const before = flagsFile();
    expect(run("preset", "presentation")).toBe(1);
    expect(output.join("\n")).toContain("Invalid flag presets");
    expect(flagsFile()).toBe(before);
  });

  it("AC-029.3: the committed presentation preset lists every flag but voice and finetunedBookmaker", () => {
    const presets = loadFlagPresets(`${CONFIG_DIR}flags.presets.json`);
    expect([...(presets["presentation"] ?? [])].sort()).toEqual(
      FLAG_NAMES.filter((name) => name !== "voice" && name !== "finetunedBookmaker").sort(),
    );
  });

  it("AC-029.3: is idempotent and keeps the file format", () => {
    run("preset", "presentation");
    const once = flagsFile();
    output = [];
    expect(run("preset", "presentation")).toBe(0);
    expect(flagsFile()).toBe(once);
    expect(output[0]).toContain("No change");
    expect(Object.keys(JSON.parse(once) as object)).toEqual([...FLAG_NAMES]);
    expect(once).toMatch(/^\{\n {2}"finetunedBookmaker": false,\n/);
    expect(once.endsWith("}\n")).toBe(true);
  });

  it("AC-029.3: a flags.json that lacks a key reads it as off and writes the whole list", () => {
    writeFileSync(`${configDir}flags.json`, '{\n  "score": false\n}\n');
    expect(run("on", "ranks")).toBe(0);
    const written = JSON.parse(flagsFile()) as Record<string, boolean>;
    expect(Object.keys(written)).toEqual([
      "score",
      ...FLAG_NAMES.filter((name) => name !== "score"),
    ]);
    expect(written["ranks"]).toBe(true);
    expect(written["voice"]).toBe(false);
  });

  it("AC-029.3: a symlinked flags.json is written through to its target and stays a link", () => {
    const target = `${configDir}elsewhere.json`;
    copyFileSync(`${configDir}flags.json`, target);
    rmSync(`${configDir}flags.json`);
    symlinkSync(target, `${configDir}flags.json`);
    expect(run("on", "score")).toBe(0);
    expect(lstatSync(`${configDir}flags.json`).isSymbolicLink()).toBe(true);
    expect((JSON.parse(readFileSync(target, "utf8")) as Record<string, boolean>)["score"]).toBe(
      true,
    );
  });

  it("AC-029.3: writes through a temporary file that does not stay behind", () => {
    run("on", "score");
    expect(readdirSync(configDir).sort()).toEqual(["flags.json", "flags.presets.json"]);
  });

  it("AC-029.3: an invalid flags file is an error, not a rewrite", () => {
    rmSync(`${configDir}flags.json`);
    expect(run("on", "score")).toBe(1);
    expect(output[0]).toContain("Cannot read");
  });

  it("AC-029.1: the committed defaults stay off", () => {
    const committed = loadFlags(`${CONFIG_DIR}flags.json`);
    for (const name of FLAG_NAMES) {
      expect(committed[name]).toBe(false);
    }
  });
});
