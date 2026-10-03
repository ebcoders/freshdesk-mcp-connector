import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FreshdeskClient } from "../src/client.js";
import { startHttpServer, type RunningHttpServer } from "../src/http.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { rawTicket } from "./fixtures.js";
import { API, mockServer, rl, testClient } from "./helpers.js";

const TOKEN = "test-http-token-0123456789";
let running: RunningHttpServer;
let fd: FreshdeskClient;
let freshdeskCalls = 0;

beforeEach(async () => {
  freshdeskCalls = 0;
  mockServer.use(
    http.get(`${API}/tickets/101`, () => {
      freshdeskCalls++;
      return HttpResponse.json(rawTicket() as JsonBodyType, { headers: rl(41 - freshdeskCalls) });
    }),
  );
  fd = testClient().client;
  running = await startHttpServer(fd, { host: "127.0.0.1", port: 0, token: TOKEN }, () => {});
});

afterEach(async () => {
  await running.close();
});

const mcpUrl = () => new URL("/mcp", running.url);

async function connectClient(token = TOKEN) {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl(), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
});

const callGetTicket = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "get_ticket", arguments: { ticket_id: 101 } },
});

/**
 * Sends raw bytes and returns the status line, for requests fetch() can't produce. Runs in a
 * child process because msw intercepts sockets in this one and chokes on malformed requests.
 */
async function rawRequest(text: string): Promise<string> {
  const { port } = new URL(running.url);
  const script = `
    const s = require("node:net").connect(${port}, "127.0.0.1", () => s.write(${JSON.stringify(text)}));
    let d = "";
    s.on("data", (c) => { d += c; if (d.includes("\\r\\n")) { process.stdout.write(d.split("\\r\\n")[0]); s.destroy(); } });
    setTimeout(() => process.exit(1), 3000).unref();`;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script]);
  return stdout;
}

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body,
  });
}

describe("HTTP transport", () => {
  it("serves the full MCP flow over HTTP with a valid bearer token", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const res = (await client.callTool({ name: "get_ticket", arguments: { ticket_id: 101 } })) as {
      structuredContent?: Record<string, any>;
    };
    expect(res.structuredContent!.ticket).toMatchObject({ id: 101, status: "Open" });
    expect(res.structuredContent!.meta.rate_limit_remaining).toBe(40);
    await client.close();
  });

  it("shares one Freshdesk client (and so one rate-limit budget) across requests", async () => {
    const a = await connectClient();
    await a.callTool({ name: "get_ticket", arguments: { ticket_id: 101 } });
    const b = await connectClient();
    const res = (await b.callTool({ name: "get_ticket", arguments: { ticket_id: 101 } })) as {
      structuredContent?: Record<string, any>;
    };
    expect(freshdeskCalls).toBe(2);
    expect(res.structuredContent!.meta.rate_limit_remaining).toBe(39);
    expect(fd.rateLimitRemaining).toBe(39); // the instance handed to the server saw both calls
    await Promise.all([a.close(), b.close()]);
  });

  it.each([
    ["no token", {}],
    ["wrong token", { Authorization: "Bearer wrong-token-0123456789" }],
    ["wrong scheme", { Authorization: `Basic ${TOKEN}` }],
  ])("rejects %s with 401 before touching Freshdesk", async (_label, headers) => {
    const res = await post(callGetTicket, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(freshdeskCalls).toBe(0);
  });

  it("accepts the Bearer scheme case-insensitively", async () => {
    const res = await post(initialize, { Authorization: `bearer ${TOKEN}` });
    expect(res.status).toBe(200);
  });

  it.each([
    ["application/json only", { Accept: "application/json" }],
    ["no Accept header", { Accept: "" }],
  ])("serves clients that send %s (responses are always JSON)", async (_label, headers) => {
    const res = await post(initialize, { Authorization: `Bearer ${TOKEN}`, ...headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "freshdesk-connector" } } });
  });

  it.each(["/mcp/", "/MCP", "//mcp", "/mcp%2f"])("does not treat %s as the MCP endpoint", async (path) => {
    expect(await rawRequest(`POST ${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Length: 0\r\n\r\n`)).toBe(
      "HTTP/1.1 404 Not Found",
    );
  });

  it("answers a malformed request target with 400, not 500", async () => {
    expect(await rawRequest("GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n")).toBe("HTTP/1.1 400 Bad Request");
  });

  it("rejects an oversized Content-Length up front, without waiting for the body", async () => {
    const status = await rawRequest(
      `POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 5000000\r\n\r\n{`,
    );
    expect(status).toBe("HTTP/1.1 413 Payload Too Large");
  });

  it("exposes an unauthenticated health check", async () => {
    const res = await fetch(new URL("/healthz", running.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers GET /mcp with 405 (stateless server, no server-initiated streams)", async () => {
    const res = await fetch(mcpUrl(), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("rejects malformed JSON with a JSON-RPC parse error", async () => {
    const res = await post("{not json", { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32700 } });
  });

  it("rejects bodies over 1 MB", async () => {
    const res = await post(JSON.stringify({ pad: "x".repeat(1_100_000) }), { Authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(413);
  });

  it("returns 404 for unknown paths", async () => {
    const res = await fetch(new URL("/nope", running.url));
    expect(res.status).toBe(404);
  });
});
