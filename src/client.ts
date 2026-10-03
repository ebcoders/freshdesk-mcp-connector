import type { Config } from "./config.js";
import {
  AuthError,
  FreshdeskError,
  NotFoundError,
  PermissionError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
} from "./errors.js";
import { RateLimiter } from "./ratelimit.js";

export type QueryValue = string | number | undefined;

export interface Page<T> {
  items: T[];
  nextPage: number | null;
}

export interface ClientDeps {
  limiter?: RateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Human label used in 404 messages, e.g. "Ticket 42". */
  notFound?: string;
}

const DEFAULT_RETRY_AFTER_S = 60;
const BACKOFF_BASE_MS = 500;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const defaultLog = (msg: string) => console.error(`[freshdesk] ${msg}`);

export function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${baseUrl}/api/v2${path}${qs ? `?${qs}` : ""}`;
}

/** Extracts the page number of the rel="next" link, e.g. `<https://x/api/v2/tickets?page=2>; rel="next"`. */
export function parseNextPage(link: string | null): number | null {
  if (!link) return null;
  const match = link.match(/<\s*([^>]+?)\s*>\s*;\s*rel="?next"?/i);
  if (!match) return null;
  try {
    const page = Number(new URL(match[1]!).searchParams.get("page"));
    return Number.isInteger(page) && page > 0 ? page : null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number {
  const seconds = Number(value);
  return value !== null && value.trim() !== "" && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds)
    : DEFAULT_RETRY_AFTER_S;
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Minimal Freshdesk REST v2 client: Basic auth, rate-limit aware retries, pagination and
 * error mapping. The public surface is read-only; `send` is protected so dev scripts can
 * subclass it for seeding without exposing writes to the connector.
 */
export class FreshdeskClient {
  readonly limiter: RateLimiter;
  private readonly authHeader: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (msg: string) => void;
  /** Set after the first successful response: proves FRESHDESK_DOMAIN points at a real helpdesk. */
  private accountVerified = false;

  constructor(
    private readonly config: Config,
    deps: ClientDeps = {},
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? defaultLog;
    this.limiter = deps.limiter ?? new RateLimiter({ maxConcurrency: config.maxConcurrency, sleep: this.sleep, now: deps.now });
    this.authHeader = `Basic ${Buffer.from(`${config.apiKey}:X`).toString("base64")}`;
  }

  /** API calls left in the current window as last reported by Freshdesk. */
  get rateLimitRemaining(): number | null {
    return this.limiter.remaining;
  }

  async get<T>(path: string, query?: Record<string, QueryValue>, notFound?: string): Promise<T> {
    return (await this.send<T>(path, { query, notFound })).data;
  }

  async getPage<T>(path: string, query?: Record<string, QueryValue>, notFound?: string): Promise<Page<T>> {
    const { data, headers } = await this.send<T[]>(path, { query, notFound });
    return { items: data, nextPage: parseNextPage(headers.get("link")) };
  }

  protected async send<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; headers: Headers }> {
    const method = opts.method ?? "GET";
    const url = buildUrl(this.config.baseUrl, path, opts.query);
    const { maxRetries, maxRetryWaitS } = this.config;
    const idempotent = method === "GET";

    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;


      let res: Response;
      try {
        res = await this.fetchOnce(url, method, opts.body);
      } catch (err) {
        if (err instanceof RateLimitedError) throw err; // cooldown too long to wait out: nothing was sent
        const reason = isTimeout(err) ? `timed out after ${this.config.timeoutMs}ms` : "network error";
        if (canRetry && idempotent) {
          await this.backoff(attempt, `${method} ${path} ${reason}`);
          continue;
        }
        throw new UpstreamError(`Freshdesk request failed (${reason}) — try again later`);
      }

      if (res.ok) {
        // The timeout signal also covers the body, so a stalled download is a timeout like any other.
        let text: string;
        try {
          text = await res.text();
        } catch (err) {
          const reason = isTimeout(err) ? `timed out after ${this.config.timeoutMs}ms` : "response could not be read";
          if (canRetry && idempotent) {
            await this.backoff(attempt, `${method} ${path} ${reason}`);
            continue;
          }
          throw new UpstreamError(`Freshdesk request failed (${reason}) — try again later`);
        }
        const data = parseJson<T>(text);
        this.accountVerified = true;
        return { data, headers: res.headers };
      }

      if (res.status === 429) {
        await discardBody(res);
        const retryAfter = parseRetryAfter(res.headers.get("retry-after")); // fetchOnce already paused the limiter
        if (!canRetry || retryAfter > maxRetryWaitS) throw new RateLimitedError(retryAfter);
        this.log(`rate limited on ${method} ${path}; waiting ${retryAfter}s (retry ${attempt + 1}/${maxRetries})`);
        continue;
      }

      if (res.status >= 500) {
        await discardBody(res);
        if (canRetry && idempotent) {
          await this.backoff(attempt, `${method} ${path} returned HTTP ${res.status}`);
          continue;
        }
        throw new UpstreamError(`Freshdesk returned HTTP ${res.status} — try again later`, res.status);
      }

      throw await toClientError(res, opts.notFound, this.accountVerified);
    }
  }

  private async fetchOnce(url: string, method: string, body: unknown): Promise<Response> {
    // Never sends into a 429 cooldown; refuses (RateLimitedError) if it is longer than we may wait.
    const release = await this.limiter.acquire(this.config.maxRetryWaitS * 1000);
    try {
      const headers: Record<string, string> = { Authorization: this.authHeader, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      this.limiter.update(res.headers, res.status);
      // Register the account-wide cooldown before releasing the slot, so no queued request slips in.
      if (res.status === 429) this.limiter.pause(parseRetryAfter(res.headers.get("retry-after")) * 1000);
      return res;
    } finally {
      release();
    }
  }

  private async backoff(attempt: number, reason: string): Promise<void> {
    const ms = Math.round(BACKOFF_BASE_MS * 2 ** attempt * (0.75 + this.random() * 0.5));
    this.log(`${reason}; retrying in ${ms}ms (retry ${attempt + 1}/${this.config.maxRetries})`);
    await this.sleep(ms);
  }
}

/** Frees the connection of a response we are not going to read. */
async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new UpstreamError("Freshdesk returned a non-JSON response — check FRESHDESK_DOMAIN");
  }
}

interface FreshdeskErrorBody {
  description?: string;
  message?: string;
  errors?: Array<{ field?: string; message?: string }>;
}

async function toClientError(res: Response, notFound: string | undefined, accountVerified: boolean): Promise<FreshdeskError> {
  if (res.status >= 300 && res.status < 400) {
    return new UpstreamError(`Freshdesk redirected the request (HTTP ${res.status}) — check FRESHDESK_DOMAIN`, res.status);
  }
  const isJson = res.headers.get("content-type")?.includes("json") ?? false;
  if (res.status === 404 && !isJson) {
    // Freshdesk API 404s are JSON; an HTML 404 means we are not talking to a helpdesk's API at all.
    return new UpstreamError(`Freshdesk returned a non-API response (HTTP 404) — check FRESHDESK_DOMAIN`, 404);
  }
  const body = (await res.json().catch(() => null)) as FreshdeskErrorBody | null;
  switch (res.status) {
    case 400: {
      const details = body?.errors?.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).filter(Boolean);
      const summary = details?.length ? details.join("; ") : (body?.description ?? body?.message ?? "invalid request");
      return new ValidationError(`Freshdesk rejected the request — ${summary}`, 400);
    }
    case 401:
      return new AuthError("Authentication failed — check FRESHDESK_API_KEY and FRESHDESK_DOMAIN", 401);
    case 403:
      return new PermissionError("Not permitted — the API key's role or Freshdesk plan does not allow this request", 403);
    case 404: {
      // Freshdesk answers an unknown subdomain with the same empty JSON 404 as a missing record.
      const what = notFound ? `${notFound} not found` : "Resource not found";
      const hint = accountVerified ? "" : " — if every lookup fails like this, check FRESHDESK_DOMAIN";
      return new NotFoundError(what + hint, 404);
    }
    default: {
      const detail = body?.errors?.map((e) => (e.field ? `${e.field}: ${e.message}` : e.message)).find(Boolean) ?? body?.description;
      return new UpstreamError(`Freshdesk returned HTTP ${res.status}${detail ? ` — ${detail}` : ""}`, res.status);
    }
  }
}
