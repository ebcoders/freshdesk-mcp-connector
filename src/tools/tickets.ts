import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreshdeskClient } from "../client.js";
import { toConversation, toTicketDetail, toTicketSummary, type RawConversation, type RawTicket } from "../mappers.js";
import { buildTicketQuery, SEARCH_MAX_PAGE, searchNextPage } from "../query.js";
import {
  conversationSchema,
  metaSchema,
  PRIORITY_LABELS,
  STATUS_LABELS,
  ticketDetailSchema,
  ticketSummarySchema,
} from "../schemas.js";
import { meta, READ_ONLY, run } from "./result.js";

const DEFAULT_PER_PAGE = 30;
const ticketId = z.number().int().positive().describe("Freshdesk ticket id");
const date = (description: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe(`${description} (YYYY-MM-DD, UTC)`);
/** Conversation bodies can each be up to 4000 characters, so threads page in smaller chunks. */
const DEFAULT_CONVERSATIONS_PER_PAGE = 10;
const perPage = (fallback: number) =>
  z.number().int().min(1).max(100).optional().describe(`Results per page, 1–100 (default ${fallback})`);

export function registerTicketTools(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "list_tickets",
    {
      title: "List tickets",
      description:
        "List Freshdesk tickets, most recently created first. Without updated_since Freshdesk only returns tickets " +
        "created in the last 30 days. Filter by requester email, company or a predefined view; for status, priority, " +
        "tag or date-range filters use search_tickets instead.",
      inputSchema: {
        filter: z
          .enum(["new_and_my_open", "watching", "spam", "deleted"])
          .optional()
          .describe("Predefined Freshdesk view (relative to the API key's agent)"),
        requester_email: z.email().optional().describe("Only tickets raised by this email address"),
        company_id: z.number().int().positive().optional().describe("Only tickets from this company"),
        updated_since: z
          .union([z.iso.date(), z.iso.datetime({ offset: true })])
          .optional()
          .describe("Only tickets updated at or after this ISO 8601 date/time; also lifts the 30-day default window"),
        order_by: z.enum(["created_at", "due_by", "updated_at", "status"]).optional().describe("Sort field (default created_at)"),
        order_type: z.enum(["asc", "desc"]).optional().describe("Sort direction (default desc)"),
        page: z.number().int().min(1).max(300).optional().describe("Page number, starting at 1"),
        per_page: perPage(DEFAULT_PER_PAGE),
      },
      outputSchema: { tickets: z.array(ticketSummarySchema), meta: metaSchema },
      annotations: READ_ONLY,
    },
    (args) =>
      run(async () => {
        const { items, nextPage } = await client.getPage<RawTicket>("/tickets", {
          filter: args.filter,
          email: args.requester_email,
          company_id: args.company_id,
          updated_since: args.updated_since,
          order_by: args.order_by,
          order_type: args.order_type,
          page: args.page ?? 1,
          per_page: args.per_page ?? DEFAULT_PER_PAGE,
        });
        return { tickets: items.map(toTicketSummary), meta: meta(client, nextPage) };
      }),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get ticket",
      description:
        "Get one ticket by id: subject, status, priority, tags, assignment, due date, plain-text description, " +
        "requester contact details and custom fields. Use list_ticket_conversations for the reply/note thread.",
      inputSchema: { ticket_id: ticketId },
      outputSchema: { ticket: ticketDetailSchema, meta: metaSchema },
      annotations: READ_ONLY,
    },
    ({ ticket_id }) =>
      run(async () => {
        const raw = await client.get<RawTicket>(`/tickets/${ticket_id}`, { include: "requester" }, `Ticket ${ticket_id}`);
        return { ticket: toTicketDetail(raw), meta: meta(client, null) };
      }),
  );

  server.registerTool(
    "list_ticket_conversations",
    {
      title: "List ticket conversations",
      description:
        "List the conversation thread of a ticket, oldest first: customer replies (direction=incoming), agent replies " +
        "and internal notes (kind=note, private=true are agent-only). Bodies are plain text, truncated at 4000 characters.",
      inputSchema: {
        ticket_id: ticketId,
        page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
        per_page: perPage(DEFAULT_CONVERSATIONS_PER_PAGE),
      },
      outputSchema: { ticket_id: z.number().int(), conversations: z.array(conversationSchema), meta: metaSchema },
      annotations: READ_ONLY,
    },
    ({ ticket_id, page, per_page }) =>
      run(async () => {
        const { items, nextPage } = await client.getPage<RawConversation>(
          `/tickets/${ticket_id}/conversations`,
          { page: page ?? 1, per_page: per_page ?? DEFAULT_CONVERSATIONS_PER_PAGE },
          `Ticket ${ticket_id}`,
        );
        return { ticket_id, conversations: items.map(toConversation), meta: meta(client, nextPage) };
      }),
  );

  server.registerTool(
    "search_tickets",
    {
      title: "Search tickets",
      description:
        "Search tickets by status, priority, tag, group, assigned agent and created/updated date ranges. Values of one " +
        "field are OR-ed, different fields are AND-ed; at least one criterion is required. Freshdesk returns 30 results " +
        `per page and at most ${SEARCH_MAX_PAGE} pages (300 results); 'total' tells you how many matched. ` +
        "Newly created tickets can take a short while to become searchable.",
      inputSchema: {
        status: z.array(z.enum(STATUS_LABELS)).optional().describe("Match any of these statuses"),
        priority: z.array(z.enum(PRIORITY_LABELS)).optional().describe("Match any of these priorities"),
        tag: z.string().max(100).optional().describe("Exact tag"),
        group_id: z.number().int().positive().optional().describe("Assigned group id"),
        agent_id: z.number().int().positive().optional().describe("Assigned agent id"),
        created_after: date("Created on or after").optional(),
        created_before: date("Created on or before").optional(),
        updated_after: date("Updated on or after").optional(),
        updated_before: date("Updated on or before").optional(),
        page: z.number().int().min(1).max(SEARCH_MAX_PAGE).optional().describe(`Page number, 1–${SEARCH_MAX_PAGE}`),
      },
      outputSchema: { total: z.number().int(), tickets: z.array(ticketSummarySchema), meta: metaSchema },
      annotations: READ_ONLY,
    },
    ({ page, ...criteria }) =>
      run(async () => {
        const query = buildTicketQuery(criteria);
        const current = page ?? 1;
        const data = await client.get<{ total: number; results: RawTicket[] }>("/search/tickets", { query, page: current });
        return {
          total: data.total,
          tickets: data.results.map(toTicketSummary),
          meta: meta(client, searchNextPage(current, data.total)),
        };
      }),
  );
}
