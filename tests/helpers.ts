import { http, passthrough } from "msw";
import { setupServer } from "msw/node";
import { FreshdeskClient, type ClientDeps } from "../src/client.js";
import type { Config } from "../src/config.js";

export const BASE = "https://acme.freshdesk.com";
export const API = `${BASE}/api/v2`;
export const API_KEY = "test-secret-key-123";

/** Freshdesk is always mocked; requests to servers the tests start on 127.0.0.1 go through for real. */
export const mockServer = setupServer(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: BASE,
    apiKey: API_KEY,
    timeoutMs: 1000,
    maxRetries: 3,
    maxRetryWaitS: 30,
    maxConcurrency: 2,
    ...overrides,
  };
}

/** Client on a fake clock: sleeps are instant, recorded, and advance `now`; jitter is deterministic. */
export function testClient(overrides: Partial<Config> = {}, deps: ClientDeps = {}) {
  const sleeps: number[] = [];
  const logs: string[] = [];
  let clock = 1_000_000;
  const client = new FreshdeskClient(testConfig(overrides), {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
    log: (m) => logs.push(m),
    ...deps,
  });
  return { client, sleeps, logs, now: () => clock };
}

/** Freshdesk rate-limit response headers. */
export function rl(remaining = 45, total = 50): Record<string, string> {
  return {
    "X-RateLimit-Total": String(total),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Used-CurrentRequest": "1",
  };
}
