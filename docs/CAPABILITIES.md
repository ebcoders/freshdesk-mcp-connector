# What the agent can and cannot do

This connector gives an agent **read-only** access to a single Freshdesk helpdesk through six MCP tools.
Full schemas: [TOOLS.md](TOOLS.md).

## The agent can

| Goal | Tool(s) |
|---|---|
| See recent tickets (last 30 days unless `updated_since` is given), optionally for one customer email or company | `list_tickets` |
| Find tickets by status, priority, tag, group, assigned agent or created/updated date range | `search_tickets` |
| Read a ticket's details: subject, status, priority, channel, tags, due date, assignment, description, custom fields, requester | `get_ticket` |
| Read the conversation thread: customer replies, agent replies, internal notes | `list_ticket_conversations` |
| Look up a customer by id, exact email, exact phone, company or sign-up date | `get_contact`, `search_contacts` |
| Page through large result sets | `meta.next_page` on every list/search result |
| Pace itself | `meta.rate_limit_remaining`; `RateLimitedError.retry_after_seconds` |

## The agent cannot

- **Change anything.** No creating, updating, replying to, assigning, merging, closing or deleting tickets or contacts. Every tool is annotated `readOnlyHint: true`, and the connector only issues HTTP GET requests.
- **See more than the API key's agent can.** Visibility follows that agent's role and group permissions in Freshdesk.
- **Search beyond Freshdesk's limits.** Search returns 30 results per page and at most 10 pages (300 results); `total` shows when results were cut off. Narrow the criteria to see the rest.
- **List old tickets without a date.** `list_tickets` returns tickets created in the last 30 days unless `updated_since` is given (Freshdesk's default).
- **Fuzzy-search.** Contact search matches exact email/phone; there is no name or free-text search. Search values containing quotes or backslashes (e.g. an email like `o'brien@example.com`) are rejected, because Freshdesk's query language cannot escape them; use `list_tickets` with `requester_email` for such customers. Ticket search has no full-text search over subjects or bodies.
- **Read attachments, satisfaction ratings, time entries, SLA policies, companies, agents or groups.** Group, agent and company appear as ids only.
- **Read custom statuses or custom fields by label.** Custom statuses show as `Custom (<code>)`; custom fields are returned with raw API names and values.
- **Read very long bodies in full.** Ticket descriptions and conversation bodies are truncated at 4,000 characters (`*_truncated: true`), and conversations page 10 at a time by default.
- **See brand-new tickets in search immediately.** Freshdesk's search index can lag by a short time; `list_tickets` and `get_ticket` are immediate.

## Authentication

Freshdesk API key (HTTP Basic auth, `key:X`) supplied via `FRESHDESK_API_KEY`, scoped to the agent that owns the key. The key never appears in logs or errors. The domain is restricted to `*.freshdesk.com` and redirects are not followed, so a mistyped domain cannot send the key elsewhere.

## Transports and access control

- **stdio** (default): the MCP host launches the server locally; nothing listens on the network.
- **Streamable HTTP** (`MCP_TRANSPORT=http`): `POST /mcp`, protected by a shared bearer token (`MCP_HTTP_TOKEN`, ≥ 16 characters, compared in constant time). It binds to `127.0.0.1` unless `HOST` is set, caps request bodies at 1 MB, and serves an unauthenticated `GET /healthz`. It is stateless (no server-initiated streams), and all callers share one Freshdesk client and therefore one rate-limit budget. TLS is expected to be terminated in front of it.

## Rate limits

Freshdesk limits API calls per minute for the whole account (the trial allows 50 per minute). The connector:

1. caps itself at 2 requests in flight;
2. when under 10% of the minute's budget is left, spaces requests at the plan's sustained rate (60s ÷ limit);
3. on HTTP 429 pauses **all** requests for `Retry-After` (the limit is account-wide), then retries (up to 3 times). If the wait would exceed 30s it returns `RateLimitedError` with `retry_after_seconds` straight away, and later calls during that cooldown are answered the same way without spending API budget, so the agent is never stuck;
4. retries 5xx errors, network errors and 15s timeouts with exponential backoff.

`get_ticket` embeds the requester, which costs one extra API credit per call.

## Errors the agent may see

| type | Meaning | What the agent should do |
|---|---|---|
| `ValidationError` | Bad input (e.g. no search criteria, invalid date, quotes in a tag) or Freshdesk rejected a parameter | Fix the arguments |
| `NotFoundError` | Ticket/contact id does not exist or is not visible (before any successful call, the message also suggests checking `FRESHDESK_DOMAIN`, since Freshdesk answers unknown helpdesks the same way) | Check the id; if everything is "not found", tell the operator |
| `AuthError` | Wrong API key or domain | Tell the operator |
| `PermissionError` | Key's role or plan can't access this | Tell the operator |
| `RateLimitedError` | Budget exhausted | Wait `retry_after_seconds` |
| `UpstreamError` | Freshdesk down, timing out, or misconfigured domain | Retry later / tell the operator |

## Assumptions

- Freshdesk REST API v2, one helpdesk per server instance.
- The operator supplies an API key for an agent with read access to the tickets the agent should see.
- Standard ticket statuses (2–5) and priorities (1–4).

## Recommended long-term improvements

- **OAuth instead of personal API keys:** publish as a Freshworks marketplace app (or use Freshworks' OAuth for custom apps) so each Agent Studio workspace authorises with scoped, revocable tokens instead of a user's personal key.
- **Write tools behind confirmation:** `add_private_note`, `reply_to_ticket`, `update_ticket_status`, marked `destructiveHint` and gated by human approval in Agent Studio.
- **Freshness and cost:** webhooks into a cache for hot tickets; resolve group/agent/company ids and custom status labels once per session.
- **Multi-tenant hosting:** per-tenant Freshdesk credentials (from a secrets manager or OAuth) instead of one key per process, per-tenant auth on the HTTP endpoint instead of a shared bearer token, and a shared rate-limit budget across server replicas (e.g. in Redis).
- **Observability:** structured logs and metrics for 429s, retries and latency.
