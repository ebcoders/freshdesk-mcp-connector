import type { Contact, Conversation, Person, PriorityLabel, StatusLabel, TicketDetail, TicketSummary } from "./schemas.js";

/** Raw Freshdesk API v2 shapes — only the fields we read. Freshdesk returns null liberally. */
export interface RawPerson {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
}

export interface RawTicket {
  id: number;
  subject?: string | null;
  status?: number | null;
  priority?: number | null;
  source?: number | null;
  type?: string | null;
  tags?: string[] | null;
  requester_id?: number | null;
  responder_id?: number | null;
  group_id?: number | null;
  company_id?: number | null;
  due_by?: string | null;
  fr_due_by?: string | null;
  created_at: string;
  updated_at: string;
  description?: string | null;
  description_text?: string | null;
  requester?: RawPerson | null;
  cc_emails?: string[] | null;
  custom_fields?: Record<string, unknown> | null;
}

export interface RawConversation {
  id: number;
  body?: string | null;
  body_text?: string | null;
  incoming?: boolean | null;
  private?: boolean | null;
  /** 0 = reply, 2 = note, others = forwards etc. */
  source?: number | null;
  user_id?: number | null;
  from_email?: string | null;
  to_emails?: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface RawContact {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  company_id?: number | null;
  job_title?: string | null;
  active?: boolean | null;
  tags?: string[] | null;
  created_at: string;
  updated_at: string;
}

export const STATUS_CODES: Record<StatusLabel, number> = { Open: 2, Pending: 3, Resolved: 4, Closed: 5 };
export const PRIORITY_CODES: Record<PriorityLabel, number> = { Low: 1, Medium: 2, High: 3, Urgent: 4 };

const STATUS: Record<number, string> = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };
const PRIORITY: Record<number, string> = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const SOURCE: Record<number, string> = { 1: "Email", 2: "Portal", 3: "Phone", 7: "Chat", 9: "Feedback Widget", 10: "Outbound Email" };
const NOTE_SOURCE = 2;

export const MAX_TEXT_LENGTH = 4000;
const TRUNCATION_MARK = "… [truncated]";

function label(map: Record<number, string>, code: number | null | undefined, fallback: string): string {
  if (code === null || code === undefined) return "Unknown";
  return map[code] ?? `${fallback} (${code})`;
}

export const statusLabel = (code: number | null | undefined) => label(STATUS, code, "Custom");
export const priorityLabel = (code: number | null | undefined) => label(PRIORITY, code, "Unknown");
export const sourceLabel = (code: number | null | undefined) => label(SOURCE, code, "Other");

export function truncate(text: string | null | undefined): { text: string | null; truncated: boolean } {
  if (text === null || text === undefined) return { text: null, truncated: false };
  if (text.length <= MAX_TEXT_LENGTH) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_LENGTH) + TRUNCATION_MARK, truncated: true };
}

function toPerson(raw: RawPerson): Person {
  return { id: raw.id, name: raw.name ?? null, email: raw.email ?? null, phone: raw.phone ?? null, mobile: raw.mobile ?? null };
}

export function toTicketSummary(raw: RawTicket): TicketSummary {
  return {
    id: raw.id,
    subject: raw.subject ?? null,
    status: statusLabel(raw.status),
    priority: priorityLabel(raw.priority),
    source: sourceLabel(raw.source),
    type: raw.type ?? null,
    tags: raw.tags ?? [],
    requester_id: raw.requester_id ?? null,
    responder_id: raw.responder_id ?? null,
    group_id: raw.group_id ?? null,
    company_id: raw.company_id ?? null,
    due_by: raw.due_by ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

export function toTicketDetail(raw: RawTicket): TicketDetail {
  const description = truncate(raw.description_text);
  return {
    ...toTicketSummary(raw),
    description_text: description.text,
    description_truncated: description.truncated,
    requester: raw.requester ? toPerson(raw.requester) : null,
    cc_emails: raw.cc_emails ?? [],
    custom_fields: raw.custom_fields ?? {},
  };
}

export function toConversation(raw: RawConversation): Conversation {
  const body = truncate(raw.body_text);
  const isPrivate = raw.private ?? false;
  return {
    id: raw.id,
    kind: isPrivate || raw.source === NOTE_SOURCE ? "note" : "reply",
    private: isPrivate,
    direction: raw.incoming ? "incoming" : "outgoing",
    body_text: body.text,
    body_truncated: body.truncated,
    from_email: raw.from_email ?? null,
    to_emails: raw.to_emails ?? [],
    user_id: raw.user_id ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

export function toContact(raw: RawContact): Contact {
  return {
    id: raw.id,
    name: raw.name ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
    mobile: raw.mobile ?? null,
    company_id: raw.company_id ?? null,
    job_title: raw.job_title ?? null,
    active: raw.active ?? false,
    tags: raw.tags ?? [],
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}
