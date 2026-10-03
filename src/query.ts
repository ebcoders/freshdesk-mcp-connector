import { ValidationError } from "./errors.js";
import { PRIORITY_CODES, STATUS_CODES } from "./mappers.js";
import type { PriorityLabel, StatusLabel } from "./schemas.js";

export const MAX_QUERY_LENGTH = 512;
export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_MAX_PAGE = 10;

export interface TicketSearchCriteria {
  status?: StatusLabel[];
  priority?: PriorityLabel[];
  tag?: string;
  group_id?: number;
  agent_id?: number;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
}

export interface ContactSearchCriteria {
  email?: string;
  phone?: string;
  company_id?: number;
  created_after?: string;
}

type Clause = string | null;

/**
 * Freshdesk's filter query language: `"(status:2 OR status:3) AND tag:'vip'"`.
 * The agent never writes this syntax; it passes structured criteria that are validated here.
 */
export function buildTicketQuery(c: TicketSearchCriteria): string {
  return finish([
    anyOf("status", c.status?.map((s) => STATUS_CODES[s])),
    anyOf("priority", c.priority?.map((p) => PRIORITY_CODES[p])),
    text("tag", c.tag),
    num("group_id", c.group_id),
    num("agent_id", c.agent_id),
    ...dateRange("created_at", "created_after", c.created_after, "created_before", c.created_before),
    ...dateRange("updated_at", "updated_after", c.updated_after, "updated_before", c.updated_before),
  ]);
}

export function buildContactQuery(c: ContactSearchCriteria): string {
  return finish([
    text("email", c.email),
    text("phone", c.phone),
    num("company_id", c.company_id),
    ...dateRange("created_at", "created_after", c.created_after, "created_before", undefined),
  ]);
}

/** Freshdesk search returns 30 results per page and at most 10 pages. */
export function searchNextPage(page: number, total: number): number | null {
  return page < SEARCH_MAX_PAGE && page * SEARCH_PAGE_SIZE < total ? page + 1 : null;
}

function anyOf(field: string, codes: number[] | undefined): Clause {
  if (!codes?.length) return null;
  const unique = [...new Set(codes)];
  if (unique.length === 1) return `${field}:${unique[0]}`;
  return `(${unique.map((v) => `${field}:${v}`).join(" OR ")})`;
}

function num(field: string, value: number | undefined): Clause {
  return value === undefined ? null : `${field}:${value}`;
}

/** Freshdesk has no escape syntax inside quoted values, so quote characters are rejected outright. */
function text(field: string, value: string | undefined): Clause {
  if (value === undefined) return null;
  const v = value.trim();
  if (!v) throw new ValidationError(`${field} must not be empty`);
  if (/['"\\]/.test(v)) throw new ValidationError(`${field} must not contain quotes or backslashes`);
  return `${field}:'${v}'`;
}

function checkDate(name: string, value: string): void {
  const valid =
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid) throw new ValidationError(`${name} must be a valid date in YYYY-MM-DD format`);
}

function dateRange(
  field: string,
  afterName: string,
  after: string | undefined,
  beforeName: string,
  before: string | undefined,
): Clause[] {
  if (after !== undefined) checkDate(afterName, after);
  if (before !== undefined) checkDate(beforeName, before);
  if (after !== undefined && before !== undefined && after > before) {
    throw new ValidationError(`${afterName} must not be later than ${beforeName}`);
  }
  return [after !== undefined ? `${field}:>'${after}'` : null, before !== undefined ? `${field}:<'${before}'` : null];
}

function finish(clauses: Clause[]): string {
  const parts = clauses.filter((c): c is string => c !== null);
  if (parts.length === 0) throw new ValidationError("Provide at least one search criterion");
  const query = `"${parts.join(" AND ")}"`;
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(`Search query is too long (${query.length} > ${MAX_QUERY_LENGTH} characters) — narrow the criteria`);
  }
  return query;
}
