import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FreshdeskClient } from "./client.js";
import { createServer } from "./server.js";

export interface HttpOptions {
  host: string;
  port: number;
  /** Shared secret callers send as `Authorization: Bearer <token>`. */
  token: string;
}

export interface RunningHttpServer {
  url: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison (hashing first makes the lengths equal). */
function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
  return match !== null && timingSafeEqual(digest(match[1]!), expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

/** The SDK rebuilds the request from rawHeaders, so the override has to happen there too. */
function setAccept(req: IncomingMessage, value: string): void {
  const raw: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== "accept") raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  raw.push("Accept", value);
  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw);
  req.headers.accept = value;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serves MCP over Streamable HTTP at POST /mcp, statelessly: each request gets a fresh
 * McpServer + transport, while one shared FreshdeskClient keeps a single rate-limit budget.
 */
export function startHttpServer(
  client: FreshdeskClient,
  options: HttpOptions,
  log: (msg: string) => void = (msg) => console.error(`[freshdesk] ${msg}`),
): Promise<RunningHttpServer> {
  const expectedToken = digest(options.token);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }

    if (path === "/healthz" && req.method === "GET") return sendJson(res, 200, { status: "ok" });
    if (path !== "/mcp") return sendJson(res, 404, { error: "not found" });
    if (!isAuthorized(req, expectedToken)) {
      return sendJson(res, 401, rpcError(-32001, "Unauthorized"), { "WWW-Authenticate": "Bearer" });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, rpcError(-32000, "Method not allowed: this server is stateless, use POST"), { Allow: "POST" });
    }

    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) {
      sendJson(res, 413, rpcError(-32600, "Request body too large"));
      req.resume(); // drain (bounded by requestTimeout) so the client can read the 413 instead of a reset
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, rpcError(-32600, "Request body too large"));
      return sendJson(res, 400, rpcError(-32700, "Parse error"));
    }

    const server = createServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Responses are always plain JSON (enableJsonResponse), so don't make clients also accept SSE.
    setAccept(req, "application/json, text/event-stream");
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`HTTP handler error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal error"));
      else res.end();
    });
  });

  httpServer.headersTimeout = 20_000; // slow-loris protection
  httpServer.requestTimeout = 30_000; // whole request, including a slow body upload
  httpServer.keepAliveTimeout = 65_000; // longer than common proxy idle timeouts (ALB 60s), avoiding sporadic 502s

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({
        url: `http://${options.host}:${port}`,
        close: () =>
          new Promise<void>((done) => {
            httpServer.closeAllConnections();
            httpServer.close(() => done());
          }),
      });
    });
  });
}
