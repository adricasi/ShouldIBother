import { describe, expect, it } from "vitest";

import { FakeModelClient } from "../src/server/model/fake.js";
import { LlamaCppAudioClient } from "../src/server/model/llamacpp.js";
import { OllamaClient } from "../src/server/model/ollama.js";
import {
  LOOPBACK_NO_PROXY,
  ProxyBypassError,
  proxyBypassProblem,
} from "../src/server/model/proxy-guard.js";
import { parseModelsConfig } from "../src/server/model/config.js";
import { selectModel } from "../src/server/model/select.js";

const ON = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.example:3128" };

describe("AC-027.2: model traffic never goes through a proxy", () => {
  it("is fine when the environment proxy is off, whatever else is set", () => {
    expect(proxyBypassProblem({})).toBeUndefined();
    expect(
      proxyBypassProblem({ HTTPS_PROXY: "http://p:1", HTTP_PROXY: "http://p:1" }),
    ).toBeUndefined();
    expect(
      proxyBypassProblem({ NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "http://p:1" }),
    ).toBeUndefined();
    expect(
      proxyBypassProblem({ NODE_USE_ENV_PROXY: "false", HTTPS_PROXY: "http://p:1" }),
    ).toBeUndefined();
  });

  it("is fine when the environment proxy is on but no proxy is configured", () => {
    expect(proxyBypassProblem({ NODE_USE_ENV_PROXY: "1" })).toBeUndefined();
    expect(proxyBypassProblem({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "  " })).toBeUndefined();
  });

  it("refuses a proxy with no NO_PROXY, and names the fix", () => {
    const problem = proxyBypassProblem(ON);
    expect(problem).toContain("127.0.0.1, localhost, ::1");
    expect(problem).toContain(`NO_PROXY=${LOOPBACK_NO_PROXY}`);
  });

  it.each([
    ["HTTP_PROXY", { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://p:1" }],
    ["lowercase https_proxy", { NODE_USE_ENV_PROXY: "true", https_proxy: "http://p:1" }],
    ["ALL_PROXY", { NODE_USE_ENV_PROXY: "1", ALL_PROXY: "socks5://p:1" }],
    [
      "--use-env-proxy in NODE_OPTIONS",
      { NODE_OPTIONS: "--use-env-proxy", HTTPS_PROXY: "http://p:1" },
    ],
  ])("refuses when the proxy comes from %s", (_name, env) => {
    expect(proxyBypassProblem(env)).toBeDefined();
  });

  it("accepts a NO_PROXY that covers 127.0.0.1, localhost and ::1, in any spelling", () => {
    for (const noProxy of [
      LOOPBACK_NO_PROXY,
      "127.0.0.1, localhost, [::1]",
      "internal.example,127.0.0.1:8080,localhost:11434,::1",
      ".localhost,LOCALHOST,127.0.0.1,[::1]:8080",
      "*",
    ]) {
      expect(proxyBypassProblem({ ...ON, NO_PROXY: noProxy }), noProxy).toBeUndefined();
    }
    expect(proxyBypassProblem({ ...ON, no_proxy: LOOPBACK_NO_PROXY })).toBeUndefined();
  });

  it("refuses a NO_PROXY that misses one of the three, and says which", () => {
    expect(proxyBypassProblem({ ...ON, NO_PROXY: "127.0.0.1" })).toContain("localhost, ::1");
    expect(proxyBypassProblem({ ...ON, NO_PROXY: "127.0.0.1,localhost" })).toContain("::1");
    expect(proxyBypassProblem({ ...ON, NO_PROXY: "example.com,.internal" })).toContain(
      "127.0.0.1, localhost, ::1",
    );
  });
});

describe("the runtime clients refuse to start behind a proxy", () => {
  const baseUrl = "http://127.0.0.1:11434";

  it("OllamaClient throws a ProxyBypassError that names the fix", () => {
    expect(() => new OllamaClient({ baseUrl, model: "m", keepAlive: "24h", env: ON })).toThrow(
      ProxyBypassError,
    );
    expect(() => new OllamaClient({ baseUrl, model: "m", keepAlive: "24h", env: ON })).toThrow(
      /Ollama: .*NO_PROXY=127\.0\.0\.1,localhost,::1/,
    );
  });

  it("LlamaCppAudioClient throws too", () => {
    expect(
      () => new LlamaCppAudioClient({ baseUrl: "http://127.0.0.1:8080", model: "m", env: ON }),
    ).toThrow(/llama\.cpp: .*NO_PROXY=/);
  });

  it("both start when NO_PROXY covers loopback, or when they are given their own fetch", () => {
    const env = { ...ON, NO_PROXY: LOOPBACK_NO_PROXY };
    expect(() => new OllamaClient({ baseUrl, model: "m", keepAlive: "24h", env })).not.toThrow();
    expect(
      () => new LlamaCppAudioClient({ baseUrl: "http://127.0.0.1:8080", model: "m", env }),
    ).not.toThrow();
    const ownFetch = (() => Promise.reject(new Error("unused"))) as typeof fetch;
    expect(
      () => new OllamaClient({ baseUrl, model: "m", keepAlive: "24h", env: ON, fetch: ownFetch }),
    ).not.toThrow();
  });

  it("selectModel refuses to start the app's model client behind a proxy", async () => {
    const config = parseModelsConfig({ models: { e4b: { tag: "gemma4:e4b" } } });
    await expect(
      selectModel(config, { useFake: false, fake: () => new FakeModelClient(), env: ON }),
    ).rejects.toThrow(ProxyBypassError);
    // The fake model makes no call, so it does not care.
    await expect(
      selectModel(config, { useFake: true, fake: () => new FakeModelClient(), env: ON }),
    ).resolves.toMatchObject({ mode: "fake" });
  });
});
