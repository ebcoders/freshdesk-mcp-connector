import { delay, http, HttpResponse, type JsonBodyType } from "msw";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { buildUrl, FreshdeskClient, parseNextPage } from "../src/client.js";
import {
  AuthError,
  NotFoundError,
  PermissionError,
  RateLimitedError,
  UpstreamError,
  ValidationError,
} from "../src/errors.js";
import { API, API_KEY, BASE, mockServer, rl, testClient, testConfig } from "./helpers.js";

/** Registers a handler that returns the given responses in order (last one repeats) and counts calls. */
function sequence(path: string, responses: Array<() => Response | Promise<Response>>) {
  const calls: Request[] = [];
  mockServer.use(
    http.all(`${API}${path}`, ({ request }) => {
      calls.push(request);
      const respond = responses[Math.min(calls.length - 1, responses.length - 1)]!;
      return respond();
    }),
  );
  return calls;
}

/**
 * A real local HTTP server whose first `stallCount` responses send headers and half a JSON
 * body, then stall; later responses complete. (msw's emulated sockets can't model a stall
 * mid-body cleanly, so this uses a real socket.)
 */
async function stallingServer(stallCount: number) {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (count <= stallCount) res.write('{"id":');
    else res.end('{"id":1}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const ok = (body: JsonBodyType = { id: 1 }, headers: Record<string, string> = rl()) => () =>
  HttpResponse.json(body, { headers });
const status = (code: number, headers: Record<string, string> = {}, body: JsonBodyType = {}) => () =>
  HttpResponse.json(body, { status: code, headers });

describe("buildUrl / parseNextPage", () => {
  it("builds URLs, skipping empty values and encoding the rest", () => {
    expect(buildUrl(BASE, "/search/tickets", { query: `"tag:'a b'"`, page: 2, skip: undefined, empty: "" })).toBe(
      `${API}/search/tickets?query=%22tag%3A'a%20b'%22&page=2`,
    );
    expect(buildUrl(BASE, "/tickets/1")).toBe(`${API}/tickets/1`);
  });

  it.each([
    [`<${API}/tickets?page=2>; rel="next"`, 2],
    [`< ${API}/tickets?filter=all_tickets&page=3>;rel="next"`, 3],
    [null, null],
    ["", null],
    [`<${API}/tickets?page=1>; rel="prev"`, null],
    [`<not a url>; rel="next"`, null],
  ])("parseNextPage(%j) = %j", (link, expected) => {
    expect(parseNextPage(link)).toBe(expected);
  });
});

describe("FreshdeskClient", () => {
  it("authenticates with HTTP Basic apikey:X and asks for JSON", async () => {
    const calls = sequence("/tickets/1", [ok()]);
    const { client } = testClient();
    await client.get("/tickets/1");
    const expected = `Basic ${Buffer.from(`${API_KEY}:X`).toString("base64")}`;
    expect(calls[0]!.headers.get("authorization")).toBe(expected);
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
    expect(calls[0]!.method).toBe("GET");
  });

  it("returns a page with the next page number from the Link header", async () => {
    sequence("/tickets", [
      () => HttpResponse.json([{ id: 1 }, { id: 2 }], { headers: { ...rl(44), Link: `<${API}/tickets?page=2>; rel="next"` } }),
    ]);
    const { client } = testClient();
    const page = await client.getPage<{ id: number }>("/tickets", { page: 1 });
    expect(page).toEqual({ items: [{ id: 1 }, { id: 2 }], nextPage: 2 });
    expect(client.rateLimitRemaining).toBe(44);
  });

  it("returns nextPage null on the last page", async () => {
    sequence("/tickets", [ok([{ id: 1 }])]);
    const { client } = testClient();
    expect((await client.getPage("/tickets")).nextPage).toBeNull();
  });

  it("waits Retry-After on 429 and then succeeds", async () => {
    const calls = sequence("/tickets/1", [status(429, { "Retry-After": "2", ...rl(0) }), ok()]);
    const { client, sleeps, logs } = testClient();
    expect(await client.get("/tickets/1")).toEqual({ id: 1 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(logs.join("\n")).toMatch(/rate limited.*2s/);
  });

  it("fails fast when Retry-After exceeds the configured maximum wait", async () => {
    const calls = sequence("/tickets/1", [status(429, { "Retry-After": "120" })]);
    const { client, sleeps } = testClient();
    const err = await client.get("/tickets/1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(120);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("treats a missing Retry-After as 60s (so it fails fast with the default 30s cap)", async () => {
    sequence("/tickets/1", [status(429)]);
    const { client } = testClient();
    const err = await client.get("/tickets/1").catch((e: unknown) => e);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(60);
    expect(client.rateLimitRemaining).toBe(0);
  });

  it("gives up with RateLimitedError after maxRetries 429s", async () => {
    const calls = sequence("/tickets/1", [status(429, { "Retry-After": "1" })]);
    const { client, sleeps } = testClient({ maxRetries: 3 });
    await expect(client.get("/tickets/1")).rejects.toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
  });

  it("retries 5xx with exponential backoff", async () => {
    const calls = sequence("/tickets/1", [status(503), status(502), ok()]);
    const { client, sleeps } = testClient();
    expect(await client.get("/tickets/1")).toEqual({ id: 1 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]); // random() = 0.5 → jitter factor 1.0
  });

  it("gives up on persistent 5xx with UpstreamError", async () => {
    const calls = sequence("/tickets/1", [status(500)]);
    const { client } = testClient({ maxRetries: 2 });
    await expect(client.get("/tickets/1")).rejects.toThrow(UpstreamError);
    expect(calls).toHaveLength(3);
  });

  it("retries network errors, then reports UpstreamError", async () => {
    const calls = sequence("/tickets/1", [() => HttpResponse.error()]);
    const { client } = testClient({ maxRetries: 1 });
    await expect(client.get("/tickets/1")).rejects.toThrow(/network error/);
    expect(calls).toHaveLength(2);
  });

  it("times out slow responses", async () => {
    sequence("/tickets/1", [
      async () => {
        await delay(500);
        return HttpResponse.json({ id: 1 });
      },
    ]);
    const { client } = testClient({ timeoutMs: 20, maxRetries: 0 });
    await expect(client.get("/tickets/1")).rejects.toThrow(/timed out after 20ms/);
  });

  it("maps 400 to ValidationError with Freshdesk's field errors, without retrying", async () => {
    const calls = sequence("/tickets", [
      status(400, {}, {
        description: "Validation failed",
        errors: [{ field: "updated_since", message: "It should be in the 'valid date' format", code: "invalid_value" }],
      }),
    ]);
    const { client } = testClient();
    const err = await client.get("/tickets").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toContain("updated_since: It should be in the 'valid date' format");
    expect(calls).toHaveLength(1);
  });

  it.each([
    [401, AuthError, /check FRESHDESK_API_KEY/],
    [403, PermissionError, /Not permitted/],
    [404, NotFoundError, /Ticket 9 not found/],
    [409, UpstreamError, /HTTP 409/],
  ])("maps %i to the right error", async (code, cls, message) => {
    sequence("/tickets/9", [status(code)]);
    const { client } = testClient();
    const err = await client.get("/tickets/9", undefined, "Ticket 9").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect((err as Error).message).toMatch(message);
  });

  it("does not follow redirects (a mistyped domain must not leak the key elsewhere)", async () => {
    sequence("/tickets/1", [() => new HttpResponse(null, { status: 302, headers: { Location: "https://example.com/" } })]);
    const { client } = testClient();
    await expect(client.get("/tickets/1")).rejects.toThrow(/redirected.*FRESHDESK_DOMAIN/);
  });

  it("reports non-JSON success bodies with a domain hint", async () => {
    sequence("/tickets/1", [() => HttpResponse.html("<html>Account not found</html>")]);
    const { client } = testClient();
    await expect(client.get("/tickets/1")).rejects.toThrow(/non-JSON.*FRESHDESK_DOMAIN/);
  });

  it("adds a domain hint to 404s until Freshdesk has answered successfully (unknown accounts also return empty JSON 404s)", async () => {
    sequence("/tickets/9", [status(404)]);
    sequence("/tickets/1", [ok()]);
    const { client } = testClient();
    const before = await client.get("/tickets/9", undefined, "Ticket 9").catch((e: unknown) => e);
    expect(before).toBeInstanceOf(NotFoundError);
    expect((before as Error).message).toMatch(/^Ticket 9 not found — .*check FRESHDESK_DOMAIN/);
    await client.get("/tickets/1");
    const after = await client.get("/tickets/9", undefined, "Ticket 9").catch((e: unknown) => e);
    expect((after as Error).message).toBe("Ticket 9 not found");
  });

  it("reports a 404 HTML page (unknown Freshdesk account) as a domain problem, not a missing resource", async () => {
    sequence("/tickets/42", [() => HttpResponse.html("<html>No such helpdesk</html>", { status: 404 })]);
    const { client } = testClient();
    const err = await client.get("/tickets/42", undefined, "Ticket 42").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as Error).message).toMatch(/non-API response \(HTTP 404\).*FRESHDESK_DOMAIN/);
  });

  it("retries when the body stalls past the timeout after headers arrive", async () => {
    const server = await stallingServer(1); // first response stalls, second completes
    try {
      const { client, logs } = testClient({ baseUrl: server.url, timeoutMs: 100, maxRetries: 1 });
      expect(await client.get("/tickets/1")).toEqual({ id: 1 });
      expect(server.requests()).toBe(2);
      expect(logs.join("\n")).toMatch(/timed out after 100ms/);
    } finally {
      await server.close();
    }
  });

  it("reports a body-read timeout as a timeout when retries are exhausted", async () => {
    const server = await stallingServer(Infinity);
    try {
      const { client } = testClient({ baseUrl: server.url, timeoutMs: 100, maxRetries: 0 });
      await expect(client.get("/tickets/1")).rejects.toThrow(/timed out after 100ms/);
    } finally {
      await server.close();
    }
  });

  it("includes Freshdesk's explanation for statuses without a dedicated error type", async () => {
    sequence("/contacts", [
      status(409, {}, { description: "Validation failed", errors: [{ field: "email", message: "It should be a unique value" }] }),
    ]);
    const { client } = testClient();
    await expect(client.get("/contacts")).rejects.toThrow("Freshdesk returned HTTP 409 — email: It should be a unique value");
  });

  it("after a 429 longer than the max wait, later calls fail fast without spending API budget", async () => {
    const calls = sequence("/tickets/1", [status(429, { "Retry-After": "120" })]);
    const { client } = testClient();
    await expect(client.get("/tickets/1")).rejects.toBeInstanceOf(RateLimitedError);
    const second = await client.get("/tickets/1").catch((e: unknown) => e);
    expect(second).toBeInstanceOf(RateLimitedError);
    expect((second as RateLimitedError).retryAfterSeconds).toBe(120);
    expect(calls).toHaveLength(1);
  });

  it("holds a queued request until a 429 cooldown has passed (no request is sent into the cooldown)", async () => {
    sequence("/a", [status(429, { "Retry-After": "2" }), ok({ id: "a" })]);
    const { client, now } = testClient({ maxConcurrency: 1 });
    const start = now();
    let bSentAt = -1;
    mockServer.use(
      http.get(`${API}/b`, () => {
        bSentAt = now();
        return HttpResponse.json({ id: "b" }, { headers: rl() });
      }),
    );
    const [a, b] = await Promise.all([client.get("/a"), client.get("/b")]);
    expect([a, b]).toEqual([{ id: "a" }, { id: "b" }]);
    expect(bSentAt - start).toBeGreaterThanOrEqual(2000);
  });

  it("fails a queued request fast when the cooldown exceeds the max wait, without sending it", async () => {
    sequence("/a", [status(429, { "Retry-After": "3" })]);
    const bCalls = sequence("/b", [ok({ id: "b" })]);
    const { client, sleeps } = testClient({ maxConcurrency: 1, maxRetryWaitS: 1 });
    const [a, b] = await Promise.allSettled([client.get("/a"), client.get("/b")]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(RateLimitedError);
    expect(((b as PromiseRejectedResult).reason as RateLimitedError).retryAfterSeconds).toBe(3);
    expect(bCalls).toHaveLength(0);
    expect(sleeps).toEqual([]);
  });

  it("releases its concurrency slot when a request fails, so the next one is not blocked", async () => {
    sequence("/tickets/1", [() => HttpResponse.error(), ok()]);
    const { client } = testClient({ maxConcurrency: 1, maxRetries: 1 });
    expect(await client.get("/tickets/1")).toEqual({ id: 1 });
    expect(await client.get("/tickets/1")).toEqual({ id: 1 });
  });

  it("discards the body of a response it is about to retry", async () => {
    // msw hands the client a copy of the mocked stream, so observe the cancel on the client side.
    const cancel = vi.spyOn(ReadableStream.prototype, "cancel");
    try {
      sequence("/tickets/1", [status(503), ok()]);
      const { client } = testClient();
      await client.get("/tickets/1");
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      cancel.mockRestore();
    }
  });

  it("never exposes the API key in errors or logs", async () => {
    const encoded = Buffer.from(`${API_KEY}:X`).toString("base64");
    const scenarios = [
      status(400, {}, { errors: [{ field: "x", message: "bad" }] }),
      status(401),
      status(403),
      status(404),
      status(429, { "Retry-After": "999" }),
      status(500),
      () => HttpResponse.error(),
    ];
    for (const scenario of scenarios) {
      mockServer.resetHandlers();
      sequence("/tickets/1", [scenario]);
      const { client, logs } = testClient({ maxRetries: 1 });
      const err = (await client.get("/tickets/1").catch((e: unknown) => e)) as Error;
      for (const text of [err.message, String(err.stack), ...logs]) {
        expect(text).not.toContain(API_KEY);
        expect(text).not.toContain(encoded);
      }
    }
  });

  it("never retries non-GET requests on 5xx (writes are not idempotent)", async () => {
    class WritingClient extends FreshdeskClient {
      post(path: string, body: unknown) {
        return this.send(path, { method: "POST", body });
      }
    }
    const calls = sequence("/tickets", [status(500)]);
    const client = new WritingClient(testConfig(), { sleep: async () => {}, log: () => {} });
    await expect(client.post("/tickets", { subject: "x" })).rejects.toThrow(UpstreamError);
    expect(calls).toHaveLength(1);
    expect(await calls[0]!.json()).toEqual({ subject: "x" });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
  });
});
