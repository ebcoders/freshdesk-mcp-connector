import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_LENGTH,
  priorityLabel,
  sourceLabel,
  statusLabel,
  toContact,
  toConversation,
  toTicketDetail,
  toTicketSummary,
  truncate,
} from "../src/mappers.js";
import { contactSchema, conversationSchema, ticketDetailSchema, ticketSummarySchema } from "../src/schemas.js";
import { rawContact, rawConversation, rawTicket } from "./fixtures.js";

describe("labels", () => {
  it("maps known codes", () => {
    expect([2, 3, 4, 5].map(statusLabel)).toEqual(["Open", "Pending", "Resolved", "Closed"]);
    expect([1, 2, 3, 4].map(priorityLabel)).toEqual(["Low", "Medium", "High", "Urgent"]);
    expect([1, 2, 3, 7, 9, 10].map(sourceLabel)).toEqual(["Email", "Portal", "Phone", "Chat", "Feedback Widget", "Outbound Email"]);
  });

  it("keeps unknown codes visible instead of dropping them", () => {
    expect(statusLabel(6)).toBe("Custom (6)");
    expect(priorityLabel(9)).toBe("Unknown (9)");
    expect(sourceLabel(13)).toBe("Other (13)");
    expect(statusLabel(undefined)).toBe("Unknown");
    expect(statusLabel(null)).toBe("Unknown");
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("hi")).toEqual({ text: "hi", truncated: false });
    expect(truncate(null)).toEqual({ text: null, truncated: false });
    expect(truncate(undefined)).toEqual({ text: null, truncated: false });
  });

  it("cuts long text and flags it", () => {
    const { text, truncated } = truncate("x".repeat(MAX_TEXT_LENGTH + 500));
    expect(truncated).toBe(true);
    expect(text!.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH + 20);
    expect(text!.endsWith("… [truncated]")).toBe(true);
  });
});

describe("toTicketSummary / toTicketDetail", () => {
  it("produces labelled, schema-valid output", () => {
    const summary = toTicketSummary(rawTicket());
    expect(summary).toMatchObject({ id: 101, status: "Open", priority: "High", source: "Email", tags: ["damaged", "priority-customer"] });
    expect(ticketSummarySchema.strict().parse(summary)).toEqual(summary);
  });

  it("handles sparse records with nulls and custom codes", () => {
    const sparse = toTicketDetail({ id: 7, status: 6, priority: 1, source: 13, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", subject: null, tags: null, custom_fields: null });
    expect(sparse).toMatchObject({ id: 7, subject: null, status: "Custom (6)", source: "Other (13)", tags: [], requester: null, cc_emails: [], custom_fields: {}, description_text: null });
    expect(ticketDetailSchema.strict().parse(sparse)).toEqual(sparse);
  });

  it("includes the embedded requester and truncates long descriptions", () => {
    const detail = toTicketDetail(
      rawTicket({
        description_text: "y".repeat(MAX_TEXT_LENGTH * 2),
        requester: { id: 5001, name: "Priya Nair", email: "priya.nair@example.com", phone: null, mobile: null },
      }),
    );
    expect(detail.requester).toEqual({ id: 5001, name: "Priya Nair", email: "priya.nair@example.com", phone: null, mobile: null });
    expect(detail.description_truncated).toBe(true);
    expect(detail.custom_fields).toEqual({ cf_order_id: "A-1042" });
    expect(ticketDetailSchema.strict().parse(detail)).toEqual(detail);
  });

  it("does not leak raw fields that are not in the schema", () => {
    expect(toTicketDetail(rawTicket())).not.toHaveProperty("description");
    expect(toTicketSummary(rawTicket())).not.toHaveProperty("fr_due_by");
  });
});

describe("toConversation", () => {
  it.each([
    [{ private: true, incoming: false }, "note", "outgoing"],
    [{ private: false, incoming: true }, "reply", "incoming"],
    [{ private: false, incoming: false }, "reply", "outgoing"],
  ])("%j → %s/%s", (flags, kind, direction) => {
    const c = toConversation(rawConversation(flags));
    expect(c).toMatchObject({ kind, direction, private: flags.private });
    expect(conversationSchema.strict().parse(c)).toEqual(c);
  });

  it("treats a public note (source 2) as a note", () => {
    expect(toConversation(rawConversation({ source: 2, private: false })).kind).toBe("note");
  });
});

describe("toContact", () => {
  it("produces schema-valid output, defaulting missing fields", () => {
    const c = toContact(rawContact({ tags: undefined, active: undefined, job_title: undefined }));
    expect(c).toMatchObject({ id: 5001, tags: [], active: false, job_title: null });
    expect(contactSchema.strict().parse(c)).toEqual(c);
  });
});
