import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { rawContact, rawConversation, rawTicket } from "./fixtures.js";
import { API, mockServer, rl, testClient } from "./helpers.js";

const clients: Client[] = [];

async function connect() {
  const { client: fd } = testClient();
  const server = createServer(fd);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** Captures requests to a path and replies with the given body/headers. */
function reply(path: string, body: JsonBodyType, headers: Record<string, string> = rl(), statusCode = 200) {
  const requests: URL[] = [];
  mockServer.use(
    http.get(`${API}${path}`, ({ request }) => {
      requests.push(new URL(request.url));
      return HttpResponse.json(body, { status: statusCode, headers });
    }),
  );
  return requests;
}

async function call(name: string, args: Record<string, unknown>) {
  const client = await connect();
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, any>;
    content: Array<{ type: string; text: string }>;
  };
}

describe("tool discovery", () => {
  it("exposes exactly the six read-only tools with input and output schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_contact",
      "get_ticket",
      "list_ticket_conversations",
      "list_tickets",
      "search_contacts",
      "search_tickets",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }
  });

  it("publishes server instructions describing read-only scope and the 30-day list window", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/read-only/i);
    expect(instructions).toMatch(/30 days/);
    expect(instructions).not.toMatch(/all tickets/i);
  });
});

describe("list_tickets", () => {
  it("passes filters, applies defaults and returns labelled tickets with pagination meta", async () => {
    const requests = reply("/tickets", [rawTicket(), rawTicket({ id: 102, status: 3, priority: 1 })] as JsonBodyType, {
      ...rl(41),
      Link: `<${API}/tickets?page=2>; rel="next"`,
    });
    const res = await call("list_tickets", { requester_email: "priya.nair@example.com", updated_since: "2026-09-01" });
    expect(res.isError).toBeFalsy();
    const q = requests[0]!.searchParams;
    expect(q.get("email")).toBe("priya.nair@example.com");
    expect(q.get("updated_since")).toBe("2026-09-01");
    expect(q.get("page")).toBe("1");
    expect(q.get("per_page")).toBe("30");
    expect(q.has("filter")).toBe(false);
    expect(res.structuredContent!.tickets.map((t: any) => [t.id, t.status, t.priority])).toEqual([
      [101, "Open", "High"],
      [102, "Pending", "Low"],
    ]);
    expect(res.structuredContent!.meta).toEqual({ next_page: 2, rate_limit_remaining: 41 });
    expect(JSON.parse(res.content[0]!.text)).toEqual(res.structuredContent);
    expect(res.content[0]!.text).not.toContain("\n"); // compact: the text copy duplicates structuredContent
  });

  it("rejects out-of-range per_page before calling Freshdesk", async () => {
    const res = await call("list_tickets", { per_page: 500 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/per_page/);
  });

  it("returns sparse tickets without failing output validation", async () => {
    reply("/tickets", [{ id: 9, status: 6, priority: 2, source: 13, subject: null, tags: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]);
    const res = await call("list_tickets", {});
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent!.tickets[0]).toMatchObject({ id: 9, status: "Custom (6)", tags: [] });
  });
});

describe("get_ticket", () => {
  it("embeds the requester and returns details", async () => {
    const requests = reply("/tickets/101", rawTicket({ requester: { id: 5001, name: "Priya Nair", email: "priya.nair@example.com", phone: null, mobile: null } }) as JsonBodyType);
    const res = await call("get_ticket", { ticket_id: 101 });
    expect(requests[0]!.searchParams.get("include")).toBe("requester");
    expect(res.structuredContent!.ticket).toMatchObject({
      id: 101,
      status: "Open",
      description_text: "The parcel was crushed.",
      requester: { name: "Priya Nair" },
      custom_fields: { cf_order_id: "A-1042" },
    });
    expect(res.structuredContent!.meta.next_page).toBeNull();
  });

  it("reports a missing ticket as a tool error", async () => {
    reply("/tickets/999", { message: "not found" }, {}, 404);
    const res = await call("get_ticket", { ticket_id: 999 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toMatchObject({ type: "NotFoundError", message: expect.stringMatching(/^Ticket 999 not found/) });
  });

  it("reports rate limiting with retry_after_seconds", async () => {
    reply("/tickets/101", {}, { "Retry-After": "120" }, 429);
    const res = await call("get_ticket", { ticket_id: 101 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toMatchObject({ type: "RateLimitedError", retry_after_seconds: 120 });
  });

  it("rejects a non-integer id", async () => {
    const res = await call("get_ticket", { ticket_id: "abc" });
    expect(res.isError).toBe(true);
  });
});

describe("list_ticket_conversations", () => {
  it("returns replies and notes with direction", async () => {
    reply("/tickets/101/conversations", [
      rawConversation({ id: 1, incoming: true, private: false, from_email: "priya.nair@example.com" }),
      rawConversation({ id: 2, private: true }),
    ] as JsonBodyType);
    const res = await call("list_ticket_conversations", { ticket_id: 101 });
    expect(res.structuredContent!.ticket_id).toBe(101);
    expect(res.structuredContent!.conversations.map((c: any) => [c.id, c.kind, c.direction])).toEqual([
      [1, "reply", "incoming"],
      [2, "note", "outgoing"],
    ]);
  });

  it("defaults to 10 entries per page so long threads don't flood the agent's context", async () => {
    const requests = reply("/tickets/101/conversations", []);
    await call("list_ticket_conversations", { ticket_id: 101 });
    expect(requests[0]!.searchParams.get("per_page")).toBe("10");
  });

  it("reports a missing ticket", async () => {
    reply("/tickets/5/conversations", {}, {}, 404);
    const res = await call("list_ticket_conversations", { ticket_id: 5 });
    expect(res.content[0]!.text).toContain("Ticket 5 not found");
  });
});

describe("search_tickets", () => {
  it("translates structured criteria into Freshdesk query syntax", async () => {
    const requests = reply("/search/tickets", { total: 45, results: [rawTicket()] } as JsonBodyType);
    const res = await call("search_tickets", { status: ["Open", "Pending"], priority: ["Urgent"], tag: "vip" });
    expect(requests[0]!.searchParams.get("query")).toBe(`"(status:2 OR status:3) AND priority:4 AND tag:'vip'"`);
    expect(requests[0]!.searchParams.get("page")).toBe("1");
    expect(res.structuredContent!.total).toBe(45);
    expect(res.structuredContent!.tickets).toHaveLength(1);
    expect(res.structuredContent!.meta.next_page).toBe(2);
  });

  it("returns next_page null on the last page", async () => {
    reply("/search/tickets", { total: 45, results: [] });
    const res = await call("search_tickets", { status: ["Open"], page: 2 });
    expect(res.structuredContent!.meta.next_page).toBeNull();
  });

  it("requires at least one criterion", async () => {
    const res = await call("search_tickets", {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toMatchObject({ type: "ValidationError", message: expect.stringMatching(/at least one/) });
  });

  it("rejects unknown status labels", async () => {
    const res = await call("search_tickets", { status: ["Bogus"] });
    expect(res.isError).toBe(true);
  });

  it("rejects quote injection in tags", async () => {
    const res = await call("search_tickets", { tag: "vip' OR status:2" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/must not contain quotes/);
  });

  it("rejects page beyond Freshdesk's 10-page search limit", async () => {
    const res = await call("search_tickets", { status: ["Open"], page: 11 });
    expect(res.isError).toBe(true);
  });
});

describe("contacts", () => {
  it("get_contact returns the contact", async () => {
    reply("/contacts/5001", rawContact() as JsonBodyType);
    const res = await call("get_contact", { contact_id: 5001 });
    expect(res.structuredContent!.contact).toMatchObject({ id: 5001, name: "Priya Nair", tags: ["vip"] });
  });

  it("get_contact reports missing contacts", async () => {
    reply("/contacts/1", {}, {}, 404);
    const res = await call("get_contact", { contact_id: 1 });
    expect(res.content[0]!.text).toContain("Contact 1 not found");
  });

  it("search_contacts builds an email query", async () => {
    const requests = reply("/search/contacts", { total: 1, results: [rawContact()] } as JsonBodyType);
    const res = await call("search_contacts", { email: "priya.nair@example.com" });
    expect(requests[0]!.searchParams.get("query")).toBe(`"email:'priya.nair@example.com'"`);
    expect(res.structuredContent).toMatchObject({ total: 1, meta: { next_page: null } });
    expect(res.structuredContent!.contacts[0].email).toBe("priya.nair@example.com");
  });

  it("search_contacts rejects a malformed email", async () => {
    const res = await call("search_contacts", { email: "not-an-email" });
    expect(res.isError).toBe(true);
  });
});
