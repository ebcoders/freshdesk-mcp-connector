# Live verification against a real Freshdesk account

Recorded on 2026-10-03 against a Freshdesk free-trial helpdesk (API rate limit: 50 calls/minute). The helpdesk subdomain is shown as `<trial>`. Every contact, ticket and note was created by `npm run seed` and is fictional. No API key appears in any output.

Commands, from a clean checkout with `.env` filled in:

```bash
npm run seed              # once
npm run smoke             # MCP over stdio
npm run smoke -- --http   # MCP over Streamable HTTP
```

## 1. Seeding (first run)

The trial's limit is 50 calls per minute and seeding makes about 50, so Freshdesk returned a 429 near the end. The client waited the 7 seconds Freshdesk asked for, then carried on.

```
contact  priya.nair@example.com → 87006798458
contact  arjun.mehta@example.com → 87006798459
… (10 contacts)
ticket   #4 Open     High   Order #A-1042 arrived damaged
ticket   #5 Pending  Urgent Refund not received for order #A-0988
… (20 tickets)
ticket   #22 Closed   Low    Request for product care guide
[freshdesk] rate limited on POST /tickets; waiting 7s (retry 1/6)
ticket   #23 Pending  Urgent Chargeback notification

Seeded 10 contacts and 20 tickets (tag: fictional-seed).
```

Running it again is a no-op. The check uses the ticket list rather than search, so it is not fooled by search-index lag:

```
Found 20 tickets tagged fictional-seed; nothing to do (use --force to add another set).
```

## 2. Smoke test over stdio (`npm run smoke`)

This starts the built server as a subprocess and calls every tool through the official MCP client SDK. The SDK also checks every result against the tool's output schema.

```
[freshdesk] freshdesk-connector 0.1.0 ready on stdio for https://<trial>.freshdesk.com
PASS  tools/list exposes 6 read-only tools                          list_tickets, get_ticket, list_ticket_conversations, search_tickets, get_contact, search_contacts
PASS  search_tickets tag=fictional-seed                             total=20, first=#23, next_page=null
PASS  search_tickets status=Open,Pending priority=Urgent            total=4
PASS  list_tickets per_page=2 paginates                             page1=23,22 next_page=2
PASS  get_ticket                                                    #23 "Chargeback notification" Pending/Urgent, requester=aisha.rahman@example.com
PASS  list_ticket_conversations (a seeded ticket with notes)        #21: note/outgoing/private
PASS  list_tickets requester_email filter                           2 tickets for aisha.rahman@example.com
PASS  search_contacts email                                         total=1
PASS  get_contact                                                   Aisha Rahman <aisha.rahman@example.com>
PASS  get_ticket unknown id → NotFoundError                         isError=true, NotFoundError
PASS  search_tickets invalid input → ValidationError (no API call)  rejected
11/11 checks passed. Rate-limit remaining (first search): 48
```

(`total=4` for Urgent: the 3 seeded Urgent tickets plus a sample ticket Freshdesk creates in every new account.)

## 3. Smoke test over HTTP (`npm run smoke -- --http`)

Same checks, with the server running in `MCP_TRANSPORT=http` mode behind a random bearer token. The client connects by URL.

```
[freshdesk] freshdesk-connector 0.1.0 listening on http://127.0.0.1:57001/mcp for https://<trial>.freshdesk.com
HTTP mode: http://127.0.0.1:57001/mcp
PASS  tools/list exposes 6 read-only tools                          list_tickets, get_ticket, list_ticket_conversations, search_tickets, get_contact, search_contacts
PASS  search_tickets tag=fictional-seed                             total=20, first=#23, next_page=null
PASS  search_tickets status=Open,Pending priority=Urgent            total=4
PASS  list_tickets per_page=2 paginates                             page1=23,22 next_page=2
PASS  get_ticket                                                    #23 "Chargeback notification" Pending/Urgent, requester=aisha.rahman@example.com
PASS  list_ticket_conversations (a seeded ticket with notes)        #21: note/outgoing/private
PASS  list_tickets requester_email filter                           2 tickets for aisha.rahman@example.com
PASS  search_contacts email                                         total=1
PASS  get_contact                                                   Aisha Rahman <aisha.rahman@example.com>
PASS  get_ticket unknown id → NotFoundError                         isError=true, NotFoundError
PASS  search_tickets invalid input → ValidationError (no API call)  rejected
11/11 checks passed. Rate-limit remaining (first search): 34
```

## 4. Rate limiting under a burst

60 concurrent `GET /tickets/4` calls went through `FreshdeskClient` against the 50/minute trial limit, starting from a fresh minute. The run used `FRESHDESK_MAX_RETRY_WAIT_S=60` so the client would wait out Freshdesk's cooldown instead of handing it back to the agent.

```
  3.2s [demo] budget low (4 of 50 left): pacing at 1200ms per request
  6.9s [connector] rate limited on GET /tickets/4; waiting 54s (retry 1/3)
  8.1s [connector] rate limited on GET /tickets/4; waiting 53s (retry 1/3)
 62.4s [demo] done: 60/60 succeeded, 0 failed []
```

What happened:
1. Below 10% of the budget, requests were spaced at the plan's sustained rate (60s ÷ 50 = 1.2s).
2. Freshdesk answered with 429 and `Retry-After: 54`. The connector paused **all** requests for that window, so only 2 of the 60 requests ever received a 429; the rest waited instead of each hitting the limit.
3. Once the window passed, every request completed: 60/60 succeeded.

With the default `FRESHDESK_MAX_RETRY_WAIT_S=30`, the same situation instead returns `RateLimitedError` with `retry_after_seconds` (38s in an earlier run) straight away. The agent gets an actionable answer instead of a call blocked for a minute.

## 5. Issues the live runs found (and fixes, each with an offline regression test)

| Observed live | Fix |
|---|---|
| A nonexistent subdomain returns the same empty JSON 404 as a missing ticket, so a typo looked like "Ticket N not found" | Until the first successful response, 404 messages also suggest checking `FRESHDESK_DOMAIN` |
| Freshdesk's search index lags new records by 1–2 minutes | `smoke` polls search until indexed; the seed's idempotency check uses the list endpoint; docs and tool descriptions mention the lag |
| New accounts have API-key access disabled by default | README explains how to enable it |
