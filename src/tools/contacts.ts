import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FreshdeskClient } from "../client.js";
import { toContact, type RawContact } from "../mappers.js";
import { buildContactQuery, SEARCH_MAX_PAGE, searchNextPage } from "../query.js";
import { contactSchema, metaSchema } from "../schemas.js";
import { meta, READ_ONLY, run } from "./result.js";

export function registerContactTools(server: McpServer, client: FreshdeskClient): void {
  server.registerTool(
    "get_contact",
    {
      title: "Get contact",
      description:
        "Get a customer contact by id (e.g. a ticket's requester_id): name, email, phone, company, job title, tags and status.",
      inputSchema: { contact_id: z.number().int().positive().describe("Freshdesk contact id") },
      outputSchema: { contact: contactSchema, meta: metaSchema },
      annotations: READ_ONLY,
    },
    ({ contact_id }) =>
      run(async () => {
        const raw = await client.get<RawContact>(`/contacts/${contact_id}`, undefined, `Contact ${contact_id}`);
        return { contact: toContact(raw), meta: meta(client, null) };
      }),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search contacts",
      description:
        "Find customer contacts by exact email, exact phone, company id or creation date (criteria are AND-ed; at least " +
        "one is required). Freshdesk's search does not support fuzzy name matching. 30 results per page, max " +
        `${SEARCH_MAX_PAGE} pages.`,
      inputSchema: {
        email: z.email().optional().describe("Exact email address"),
        phone: z.string().min(3).max(30).optional().describe("Exact phone number as stored in Freshdesk"),
        company_id: z.number().int().positive().optional().describe("Company id"),
        created_after: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
          .optional()
          .describe("Created on or after (YYYY-MM-DD, UTC)"),
        page: z.number().int().min(1).max(SEARCH_MAX_PAGE).optional().describe(`Page number, 1–${SEARCH_MAX_PAGE}`),
      },
      outputSchema: { total: z.number().int(), contacts: z.array(contactSchema), meta: metaSchema },
      annotations: READ_ONLY,
    },
    ({ page, ...criteria }) =>
      run(async () => {
        const query = buildContactQuery(criteria);
        const current = page ?? 1;
        const data = await client.get<{ total: number; results: RawContact[] }>("/search/contacts", { query, page: current });
        return {
          total: data.total,
          contacts: data.results.map(toContact),
          meta: meta(client, searchNextPage(current, data.total)),
        };
      }),
  );
}
