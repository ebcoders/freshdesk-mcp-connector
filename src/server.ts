import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FreshdeskClient } from "./client.js";
import { registerContactTools } from "./tools/contacts.js";
import { registerTicketTools } from "./tools/tickets.js";

export const SERVER_NAME = "freshdesk-connector";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Read-only access to one Freshdesk helpdesk.
- search_tickets: filter by status, priority, tag, group, agent or date range.
- list_tickets: tickets for a requester email / company or a predefined view; only the last 30 days unless updated_since is set.
- get_ticket: full details of one ticket; list_ticket_conversations: its reply/note thread.
- get_contact / search_contacts: customer details (exact email/phone/company match).
This connector cannot create, update, reply to, assign or delete anything.
Paginate with meta.next_page. If a call returns RateLimitedError, wait retry_after_seconds before retrying;
meta.rate_limit_remaining shows the API budget left this minute.`;

export function createServer(client: FreshdeskClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTicketTools(server, client);
  registerContactTools(server, client);
  return server;
}
