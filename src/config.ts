import { ConfigError } from "./errors.js";

export interface Config {
  /** e.g. https://acme.freshdesk.com */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryWaitS: number;
  maxConcurrency: number;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FRESHDESK_SUFFIX = ".freshdesk.com";

/**
 * Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com/" and returns the
 * canonical base URL. Anything else is rejected so the API key is only ever sent to Freshdesk.
 */
export function normaliseDomain(input: string): string {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const sub = host.endsWith(FRESHDESK_SUFFIX) ? host.slice(0, -FRESHDESK_SUFFIX.length) : host;
  if (!SUBDOMAIN.test(sub)) {
    throw new ConfigError(
      `FRESHDESK_DOMAIN must be a Freshdesk subdomain such as "acme" or "acme.freshdesk.com" (got "${input}")`,
    );
  }
  return `https://${sub}${FRESHDESK_SUFFIX}`;
}

function intVar(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(`${name} must be an integer ≥ ${min} (got "${raw}")`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const domain = env.FRESHDESK_DOMAIN?.trim();
  if (!domain) throw new ConfigError("FRESHDESK_DOMAIN is not set (e.g. FRESHDESK_DOMAIN=acme)");
  const apiKey = env.FRESHDESK_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("FRESHDESK_API_KEY is not set (Freshdesk → Profile settings → View API key)");

  return {
    baseUrl: normaliseDomain(domain),
    apiKey,
    timeoutMs: intVar(env, "FRESHDESK_TIMEOUT_MS", 15_000, 1),
    maxRetries: intVar(env, "FRESHDESK_MAX_RETRIES", 3, 0),
    maxRetryWaitS: intVar(env, "FRESHDESK_MAX_RETRY_WAIT_S", 30, 0),
    maxConcurrency: intVar(env, "FRESHDESK_MAX_CONCURRENCY", 2, 1),
  };
}

export type TransportConfig =
  | { kind: "stdio" }
  | { kind: "http"; host: string; port: number; token: string };

const MIN_TOKEN_LENGTH = 16;

/** stdio (default) for local MCP hosts; HTTP for hosted platforms that connect by URL. */
export function loadTransportConfig(env: NodeJS.ProcessEnv = process.env): TransportConfig {
  const kind = (env.MCP_TRANSPORT?.trim() || "stdio").toLowerCase();
  if (kind === "stdio") return { kind: "stdio" };
  if (kind !== "http") throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http" (got "${env.MCP_TRANSPORT}")`);

  const token = env.MCP_HTTP_TOKEN?.trim();
  if (!token) throw new ConfigError("MCP_HTTP_TOKEN is required in HTTP mode (clients send it as a Bearer token)");
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  const port = intVar(env, "PORT", 3000, 0);
  if (port > 65_535) throw new ConfigError(`PORT must be between 0 and 65535 (got "${env.PORT}")`);
  return { kind: "http", host: env.HOST?.trim() || "127.0.0.1", port, token };
}
