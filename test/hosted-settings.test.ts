import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAILY_MODEL_CALLS,
  DEFAULT_HOSTED_BIND_ADDRESS,
  HostedSettingsError,
  ignoredHostedVariables,
  parseModeSettings,
  type HostedSettings,
} from "../src/server/mode.js";

import { KEY, MODEL_ID } from "./support/fake-digitalocean.js";

const HOSTED = {
  SIB_MODE: "hosted",
  SIB_PUBLIC_ORIGIN: "https://sib.example.com",
  SIB_DO_MODEL: MODEL_ID,
  SIB_DO_INFERENCE_KEY: KEY,
};

function hosted(extra: Record<string, string | undefined> = {}): HostedSettings {
  const settings = parseModeSettings({ ...HOSTED, ...extra });
  if (settings.mode !== "hosted") {
    throw new Error("expected hosted settings");
  }
  return settings;
}

function refusal(env: Record<string, string | undefined>): string {
  try {
    parseModeSettings(env);
  } catch (error) {
    expect(error).toBeInstanceOf(HostedSettingsError);
    return (error as Error).message;
  }
  throw new Error("expected the settings to be refused");
}

describe("AC-032.1: home mode is the default", () => {
  it("is home with no SIB_MODE, an empty one or home", () => {
    expect(parseModeSettings({})).toEqual({ mode: "home" });
    expect(parseModeSettings({ SIB_MODE: "" })).toEqual({ mode: "home" });
    expect(parseModeSettings({ SIB_MODE: "home" })).toEqual({ mode: "home" });
  });

  it("refuses any other SIB_MODE value", () => {
    for (const value of ["Hosted", "prod", "1", "hosted "]) {
      if (value === "hosted ") {
        continue; // trailing blanks are trimmed, like in an env file
      }
      expect(refusal({ SIB_MODE: value }), value).toContain("SIB_MODE must be home or hosted");
    }
  });

  it("ignores every hosted variable in home mode, even a wrong one, and names them for a warning", () => {
    const env = {
      SIB_PUBLIC_ORIGIN: "http://not-https",
      SIB_DO_MODEL: "nonsense",
      SIB_DO_INFERENCE_KEY: KEY,
      SIB_DO_VISION: "yes",
      SIB_TOOL_USE: "magic",
      SIB_DAILY_MODEL_CALLS: "-5",
      SIB_BIND_ADDRESS: "nowhere",
    };
    expect(parseModeSettings(env)).toEqual({ mode: "home" });
    expect(ignoredHostedVariables(env)).toEqual(Object.keys(env));
    expect(JSON.stringify(ignoredHostedVariables(env))).not.toContain(KEY);
    expect(ignoredHostedVariables({ SIB_PORT: "1" })).toEqual([]);
  });
});

describe("AC-032.2: hosted settings are parsed once and refuse to start when wrong", () => {
  it("reads the settings and applies the defaults", () => {
    const settings = hosted();
    expect(settings).toMatchObject({
      mode: "hosted",
      publicOrigin: "https://sib.example.com",
      publicHost: "sib.example.com",
      model: MODEL_ID,
      vision: false,
      toolUse: "injected",
      dailyModelCalls: DEFAULT_DAILY_MODEL_CALLS,
      bindAddress: DEFAULT_HOSTED_BIND_ADDRESS,
    });
    expect(DEFAULT_DAILY_MODEL_CALLS).toBe(300);
    expect(DEFAULT_HOSTED_BIND_ADDRESS).toBe("0.0.0.0");
    expect(settings.inferenceKey.reveal()).toBe(KEY);
  });

  it("reads every optional setting", () => {
    const settings = hosted({
      SIB_DO_VISION: "1",
      SIB_TOOL_USE: "native",
      SIB_DAILY_MODEL_CALLS: "50",
      SIB_BIND_ADDRESS: "127.0.0.1",
      SIB_PUBLIC_ORIGIN: "https://Sib.Example.com:8443/",
    });
    expect(settings).toMatchObject({
      vision: true,
      toolUse: "native",
      dailyModelCalls: 50,
      bindAddress: "127.0.0.1",
      publicOrigin: "https://sib.example.com:8443",
      publicHost: "sib.example.com:8443",
    });
  });

  it("treats an empty value as unset", () => {
    expect(hosted({ SIB_DO_VISION: "", SIB_DAILY_MODEL_CALLS: "" })).toMatchObject({
      vision: false,
      dailyModelCalls: 300,
    });
  });

  it("names every missing required setting at once", () => {
    const message = refusal({ SIB_MODE: "hosted" });
    expect(message).toContain("SIB_PUBLIC_ORIGIN");
    expect(message).toContain("SIB_DO_MODEL");
    expect(message).toContain("SIB_DO_INFERENCE_KEY");
  });

  it("needs an https origin with nothing but scheme, host and port", () => {
    for (const origin of [
      "http://sib.example.com",
      "sib.example.com",
      "https://sib.example.com/app",
      "https://sib.example.com/?a=1",
      "https://user:secret-pass@sib.example.com",
    ]) {
      const message = refusal({ ...HOSTED, SIB_PUBLIC_ORIGIN: origin });
      expect(message, origin).toContain("SIB_PUBLIC_ORIGIN must be an https:// origin only");
      expect(message).not.toContain("secret-pass");
    }
  });

  it("needs a Gemma 4 model ID and has no default", () => {
    for (const model of ["llama-3-8b", "gemma-3-27b", "gpt-4o", "gemma 4", "gemma-4 31b"]) {
      expect(refusal({ ...HOSTED, SIB_DO_MODEL: model }), model).toContain("SIB_DO_MODEL");
    }
    expect(hosted({ SIB_DO_MODEL: "Gemma-4-E4B-it" }).model).toBe("Gemma-4-E4B-it");
    expect(refusal({ ...HOSTED, SIB_DO_MODEL: undefined })).toContain("SIB_DO_MODEL is required");
  });

  it("never prints the key, whatever is wrong with it or with something else", () => {
    for (const env of [
      { ...HOSTED, SIB_DO_INFERENCE_KEY: "short" },
      { ...HOSTED, SIB_DO_INFERENCE_KEY: "has a space in the middle of it" },
      { ...HOSTED, SIB_DO_MODEL: "bad", SIB_DO_INFERENCE_KEY: KEY },
      { ...HOSTED, SIB_TOOL_USE: "magic" },
    ]) {
      const message = refusal(env);
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("has a space");
      expect(message).not.toContain("short");
    }
    expect(refusal({ ...HOSTED, SIB_DO_INFERENCE_KEY: undefined })).toContain(
      "SIB_DO_INFERENCE_KEY is required",
    );
  });

  it("validates the optional settings", () => {
    expect(refusal({ ...HOSTED, SIB_DO_VISION: "yes" })).toContain("SIB_DO_VISION must be 0 or 1");
    expect(refusal({ ...HOSTED, SIB_TOOL_USE: "magic" })).toContain(
      "SIB_TOOL_USE must be injected or native",
    );
    for (const calls of ["0", "-1", "1.5", "abc", "99999999"]) {
      expect(refusal({ ...HOSTED, SIB_DAILY_MODEL_CALLS: calls }), calls).toContain(
        "SIB_DAILY_MODEL_CALLS must be a positive whole number",
      );
    }
    expect(refusal({ ...HOSTED, SIB_BIND_ADDRESS: "all" })).toContain("SIB_BIND_ADDRESS");
  });
});
