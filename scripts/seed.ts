/**
 * DEV ONLY — fills a Freshdesk *trial* account with fictional contacts and tickets.
 * These are the only write calls in the project; the MCP connector itself is read-only.
 * Usage: npm run seed [-- --force]
 */
import { FreshdeskClient, type Page } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { PRIORITY_CODES, STATUS_CODES } from "../src/mappers.js";
import { loadEnv } from "./env.js";
import { CONTACTS, SEED_TAG, TICKETS, type SeedContact } from "./seed-data.js";

class SeedClient extends FreshdeskClient {
  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.send<T>(path, { method: "POST", body })).data;
  }
}

const PORTAL_SOURCE = 2;

async function findOrCreateContact(client: SeedClient, contact: SeedContact): Promise<number> {
  const existing = await client.get<Array<{ id: number }>>("/contacts", { email: contact.email });
  if (existing[0]) return existing[0].id;
  const created = await client.post<{ id: number }>("/contacts", contact);
  return created.id;
}

async function countSeededTickets(client: SeedClient): Promise<number> {
  let count = 0;
  for (let page: number | null = 1; page !== null && page <= 5; ) {
    const result: Page<{ tags?: string[] | null }> = await client.getPage("/tickets", {
      updated_since: "2000-01-01T00:00:00Z",
      per_page: 100,
      page,
    });
    count += result.items.filter((t) => t.tags?.includes(SEED_TAG)).length;
    page = result.nextPage;
  }
  return count;
}

async function main(): Promise<void> {
  loadEnv();
  // Seeding makes ~50 calls; a trial allows 50/min, so allow long Retry-After waits here.
  const client = new SeedClient({ ...loadConfig(), maxRetries: 6, maxRetryWaitS: 120 });

  // Use the ticket list, not search: the search index lags, so a quick re-run would not see the first set.
  const already = await countSeededTickets(client);
  if (already > 0 && !process.argv.includes("--force")) {
    console.log(`Found ${already} tickets tagged ${SEED_TAG}; nothing to do (use --force to add another set).`);
    return;
  }

  const contactIds = new Map<string, number>();
  for (const contact of CONTACTS) {
    contactIds.set(contact.email, await findOrCreateContact(client, contact));
    console.log(`contact  ${contact.email} → ${contactIds.get(contact.email)}`);
  }

  for (const t of TICKETS) {
    const ticket = await client.post<{ id: number }>("/tickets", {
      subject: t.subject,
      description: t.description,
      requester_id: contactIds.get(t.requester),
      status: STATUS_CODES[t.status],
      priority: PRIORITY_CODES[t.priority],
      source: PORTAL_SOURCE,
      tags: [SEED_TAG, ...t.tags],
    });
    for (const note of t.notes ?? []) {
      await client.post(`/tickets/${ticket.id}/notes`, { body: note.body, private: note.private, incoming: note.incoming ?? false });
    }
    console.log(`ticket   #${ticket.id} ${t.status.padEnd(8)} ${t.priority.padEnd(6)} ${t.subject}`);
  }

  console.log(`\nSeeded ${CONTACTS.length} contacts and ${TICKETS.length} tickets (tag: ${SEED_TAG}).`);
  console.log(`Rate-limit budget remaining this minute: ${client.rateLimitRemaining ?? "unknown"}`);
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
