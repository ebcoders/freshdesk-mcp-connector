import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FreshdeskClient } from "../client.js";
import { FreshdeskError, RateLimitedError } from "../errors.js";
import type { Meta } from "../schemas.js";

export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function meta(client: FreshdeskClient, nextPage: number | null): Meta {
  return { next_page: nextPage, rate_limit_remaining: client.rateLimitRemaining };
}

const defaultLog = (msg: string) => console.error(`[freshdesk] ${msg}`);

/** Runs a tool body, returning structured content on success or an agent-readable error. */
export async function run(
  fn: () => Promise<Record<string, unknown>>,
  log: (msg: string) => void = defaultLog,
): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (err) {
    let error: Record<string, unknown>;
    if (err instanceof FreshdeskError) {
      error = { type: err.name, message: err.message };
      if (err instanceof RateLimitedError) error.retry_after_seconds = err.retryAfterSeconds;
    } else {
      log(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      error = { type: "InternalError", message: "Unexpected error while calling Freshdesk" };
    }
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }] };
  }
}
