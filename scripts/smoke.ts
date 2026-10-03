/**
 * Live end-to-end check: spawns the built MCP server over stdio and calls every tool
 * through a real MCP client against the Freshdesk account in .env.
 * Usage: npm run seed (once), then npm run smoke   (add `-- --http` to test HTTP mode)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { loadEnv } from "./env.js";
import { SEED_TAG } from "./seed-data.js";

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, any>;
  content: Array<{ type: string; text?: string }>;
}

const results: Array<{ check: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    results.push({ check: name, ok: true, detail: await fn() });
  } catch (err) {
    results.push({ check: name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Waits for the HTTP server child to log its URL. */
function serverUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolveUrl, reject) => {
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
      const match = stderr.match(/listening on (http:\/\/\S+)/);
      if (match) resolveUrl(match[1]!);
    });
    child.on("exit", (code) => reject(new Error(`server exited (${code})`)));
  });
}

/** Freshdesk's search index lags new records by up to a few minutes; poll until something matches. */
async function untilIndexed<T extends Record<string, any>>(search: () => Promise<T>, attempts = 9): Promise<T> {
  let out = await search();
  for (let i = 1; i < attempts && out.total === 0; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    out = await search();
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  loadConfig(); // fail fast with a clear message instead of "connection closed" from the child server
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const useHttp = process.argv.includes("--http");
  let httpServer: ChildProcess | undefined;
  let transport: Transport;
  if (useHttp) {
    const token = randomBytes(24).toString("hex");
    httpServer = spawn(process.execPath, [resolve("dist/index.js")], {
      env: { ...env, MCP_TRANSPORT: "http", MCP_HTTP_TOKEN: token, PORT: "0" },
      stdio: ["ignore", "inherit", "pipe"],
    });
    const child = httpServer;
    process.on("exit", () => child.kill()); // never leave the server running, whatever happens below
    const url = await serverUrl(httpServer);
    console.log(`HTTP mode: ${url}`);
    transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  } else {
    transport = new StdioClientTransport({ command: process.execPath, args: [resolve("dist/index.js")], env, stderr: "inherit" });
  }
  const client = new Client({ name: "smoke", version: "0.1.0" });
  await client.connect(transport);

  const callTool = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  const ok = async (name: string, args: Record<string, unknown>) => {
    const res = await callTool(name, args);
    assert(!res.isError, `${name} failed: ${res.content[0]?.text}`);
    return res.structuredContent!;
  };

  let ticketId = 0;
  let seededIds: number[] = [];
  let requesterId = 0;
  let requesterEmail = "";
  let remaining: unknown = null;

  await check("tools/list exposes 6 read-only tools", async () => {
    const { tools } = await client.listTools();
    assert(tools.length === 6, `expected 6 tools, got ${tools.length}`);
    assert(tools.every((t) => t.annotations?.readOnlyHint === true), "a tool is not marked read-only");
    return tools.map((t) => t.name).join(", ");
  });

  await check(`search_tickets tag=${SEED_TAG}`, async () => {
    const out = await untilIndexed(() => ok("search_tickets", { tag: SEED_TAG }));
    assert(out.total > 0, "no seeded tickets found — run `npm run seed` and retry in a minute");
    ticketId = out.tickets[0].id;
    seededIds = out.tickets.map((t: any) => t.id);
    requesterId = out.tickets[0].requester_id;
    remaining = out.meta.rate_limit_remaining;
    return `total=${out.total}, first=#${ticketId}, next_page=${out.meta.next_page}`;
  });

  await check("search_tickets status=Open,Pending priority=Urgent", async () => {
    const out = await ok("search_tickets", { status: ["Open", "Pending"], priority: ["Urgent"] });
    assert(out.tickets.every((t: any) => ["Open", "Pending"].includes(t.status) && t.priority === "Urgent"), "filter not respected");
    return `total=${out.total}`;
  });

  await check("list_tickets per_page=2 paginates", async () => {
    const first = await ok("list_tickets", { per_page: 2 });
    assert(first.tickets.length > 0, "no tickets listed");
    if (first.meta.next_page) {
      const second = await ok("list_tickets", { per_page: 2, page: first.meta.next_page });
      assert(second.tickets[0]?.id !== first.tickets[0].id, "page 2 repeated page 1");
    }
    return `page1=${first.tickets.map((t: any) => t.id).join(",")} next_page=${first.meta.next_page}`;
  });

  await check("get_ticket", async () => {
    assert(ticketId, "no ticket id from search");
    const { ticket } = await ok("get_ticket", { ticket_id: ticketId });
    requesterEmail = ticket.requester?.email ?? "";
    return `#${ticket.id} "${ticket.subject}" ${ticket.status}/${ticket.priority}, requester=${requesterEmail}`;
  });

  await check("list_ticket_conversations (a seeded ticket with notes)", async () => {
    // Only some seeded tickets have notes; look through them until one has a thread.
    for (const id of seededIds) {
      const out = await ok("list_ticket_conversations", { ticket_id: id });
      if (out.conversations.length > 0) {
        return `#${id}: ${out.conversations.map((c: any) => `${c.kind}/${c.direction}${c.private ? "/private" : ""}`).join(", ")}`;
      }
    }
    throw new Error("no seeded ticket has conversations — the seed creates notes on several");
  });

  await check("list_tickets requester_email filter", async () => {
    assert(requesterEmail, "no requester email");
    const out = await ok("list_tickets", { requester_email: requesterEmail });
    assert(out.tickets.every((t: any) => t.requester_id === requesterId), "returned another requester's ticket");
    return `${out.tickets.length} tickets for ${requesterEmail}`;
  });

  await check("search_contacts email", async () => {
    const out = await untilIndexed(() => ok("search_contacts", { email: requesterEmail }));
    assert(out.total >= 1 && out.contacts[0].email === requesterEmail, "contact not found by email");
    return `total=${out.total}`;
  });

  await check("get_contact", async () => {
    const { contact } = await ok("get_contact", { contact_id: requesterId });
    return `${contact.name} <${contact.email}>`;
  });

  await check("get_ticket unknown id → NotFoundError", async () => {
    const res = await callTool("get_ticket", { ticket_id: 999_999_999 });
    assert(res.isError, "expected an error");
    assert(res.content[0]?.text?.includes("NotFoundError"), `unexpected error: ${res.content[0]?.text}`);
    return "isError=true, NotFoundError";
  });

  await check("search_tickets invalid input → ValidationError (no API call)", async () => {
    const res = await callTool("search_tickets", { tag: "x' OR status:2" });
    assert(res.isError, "expected an error");
    return "rejected";
  });

  await client.close();

  const width = Math.max(...results.map((r) => r.check.length));
  console.log("");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.check.padEnd(width)}  ${r.detail}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Rate-limit remaining (first search): ${String(remaining)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
