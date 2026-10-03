import { describe, expect, it } from "vitest";
import { loadConfig, loadTransportConfig, normaliseDomain } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("normaliseDomain", () => {
  it.each([
    ["acme", "https://acme.freshdesk.com"],
    ["acme.freshdesk.com", "https://acme.freshdesk.com"],
    ["https://acme.freshdesk.com/", "https://acme.freshdesk.com"],
    ["  ACME-Support  ", "https://acme-support.freshdesk.com"],
  ])("accepts %s", (input, expected) => {
    expect(normaliseDomain(input)).toBe(expected);
  });

  it.each([
    "evil.com",
    "acme.freshdesk.com.evil.com",
    "acme.freshdesk.com/api/v2",
    "https://acme.zendesk.com",
    "-acme",
    "",
    "ac me",
  ])("rejects %j", (input) => {
    expect(() => normaliseDomain(input)).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  const base = { FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k" };

  it("applies defaults", () => {
    expect(loadConfig(base)).toEqual({
      baseUrl: "https://acme.freshdesk.com",
      apiKey: "k",
      timeoutMs: 15000,
      maxRetries: 3,
      maxRetryWaitS: 30,
      maxConcurrency: 2,
    });
  });

  it("reads overrides", () => {
    const cfg = loadConfig({ ...base, FRESHDESK_TIMEOUT_MS: "500", FRESHDESK_MAX_RETRIES: "0", FRESHDESK_MAX_RETRY_WAIT_S: "5", FRESHDESK_MAX_CONCURRENCY: "4" });
    expect(cfg).toMatchObject({ timeoutMs: 500, maxRetries: 0, maxRetryWaitS: 5, maxConcurrency: 4 });
  });

  it("requires domain and key", () => {
    expect(() => loadConfig({ FRESHDESK_API_KEY: "k" })).toThrow(/FRESHDESK_DOMAIN/);
    expect(() => loadConfig({ FRESHDESK_DOMAIN: "acme" })).toThrow(/FRESHDESK_API_KEY/);
    expect(() => loadConfig({ FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "   " })).toThrow(/FRESHDESK_API_KEY/);
  });

  it.each([
    ["FRESHDESK_TIMEOUT_MS", "abc"],
    ["FRESHDESK_TIMEOUT_MS", "0"],
    ["FRESHDESK_MAX_RETRIES", "-1"],
    ["FRESHDESK_MAX_CONCURRENCY", "1.5"],
  ])("rejects invalid %s=%s", (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow(new RegExp(key));
  });

  it("never echoes the API key in errors", () => {
    try {
      loadConfig({ FRESHDESK_DOMAIN: "evil.com", FRESHDESK_API_KEY: "super-secret" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("super-secret");
    }
  });
});

describe("loadTransportConfig", () => {
  const token = "a-long-enough-token-1234";

  it("defaults to stdio", () => {
    expect(loadTransportConfig({})).toEqual({ kind: "stdio" });
  });

  it("reads HTTP settings with safe defaults (localhost only)", () => {
    expect(loadTransportConfig({ MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: token })).toEqual({
      kind: "http",
      host: "127.0.0.1",
      port: 3000,
      token,
    });
    expect(loadTransportConfig({ MCP_TRANSPORT: "HTTP", MCP_HTTP_TOKEN: token, HOST: "0.0.0.0", PORT: "8080" })).toMatchObject({
      host: "0.0.0.0",
      port: 8080,
    });
  });

  it("refuses to start HTTP mode without a strong token", () => {
    expect(() => loadTransportConfig({ MCP_TRANSPORT: "http" })).toThrow(/MCP_HTTP_TOKEN is required/);
    expect(() => loadTransportConfig({ MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: "short" })).toThrow(/at least 16 characters/);
  });

  it("rejects unknown transports and bad ports", () => {
    expect(() => loadTransportConfig({ MCP_TRANSPORT: "carrier-pigeon" })).toThrow(/MCP_TRANSPORT/);
    expect(() => loadTransportConfig({ MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: token, PORT: "70000" })).toThrow(/PORT/);
  });
});
