import { z } from "zod";

export const STATUS_LABELS = ["Open", "Pending", "Resolved", "Closed"] as const;
export const PRIORITY_LABELS = ["Low", "Medium", "High", "Urgent"] as const;
export type StatusLabel = (typeof STATUS_LABELS)[number];
export type PriorityLabel = (typeof PRIORITY_LABELS)[number];

const id = z.number().int();
const timestamp = z.string().describe("ISO 8601 timestamp (UTC)");

export const metaSchema = z.object({
  next_page: z.number().int().nullable().describe("Pass as `page` to fetch more results; null when there are no more"),
  rate_limit_remaining: z
    .number()
    .int()
    .nullable()
    .describe("Freshdesk API calls left in the current minute, as last reported (null if unknown)"),
});

export const ticketSummarySchema = z.object({
  id,
  subject: z.string().nullable(),
  status: z.string().describe('"Open", "Pending", "Resolved", "Closed" or "Custom (<code>)"'),
  priority: z.string().describe('"Low", "Medium", "High" or "Urgent"'),
  source: z.string().describe('Channel, e.g. "Email", "Portal", "Phone", "Chat"'),
  type: z.string().nullable(),
  tags: z.array(z.string()),
  requester_id: id.nullable(),
  responder_id: id.nullable().describe("Assigned agent id"),
  group_id: id.nullable(),
  company_id: id.nullable(),
  due_by: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const personSchema = z.object({
  id,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
});

export const ticketDetailSchema = ticketSummarySchema.extend({
  description_text: z.string().nullable().describe("Plain-text description (truncated to 4000 characters)"),
  description_truncated: z.boolean(),
  requester: personSchema.nullable(),
  cc_emails: z.array(z.string()),
  custom_fields: z.record(z.string(), z.unknown()).describe("Custom ticket fields, raw values keyed by API name"),
});

export const conversationSchema = z.object({
  id,
  kind: z.enum(["reply", "note"]).describe("note = internal/agent note, reply = email/portal reply"),
  private: z.boolean().describe("Private notes are visible to agents only"),
  direction: z.enum(["incoming", "outgoing"]).describe("incoming = from the customer"),
  body_text: z.string().nullable().describe("Plain-text body (truncated to 4000 characters)"),
  body_truncated: z.boolean(),
  from_email: z.string().nullable(),
  to_emails: z.array(z.string()),
  user_id: id.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const contactSchema = z.object({
  id,
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  mobile: z.string().nullable(),
  company_id: id.nullable(),
  job_title: z.string().nullable(),
  active: z.boolean(),
  tags: z.array(z.string()),
  created_at: timestamp,
  updated_at: timestamp,
});

export type Meta = z.infer<typeof metaSchema>;
export type TicketSummary = z.infer<typeof ticketSummarySchema>;
export type TicketDetail = z.infer<typeof ticketDetailSchema>;
export type Person = z.infer<typeof personSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Contact = z.infer<typeof contactSchema>;
