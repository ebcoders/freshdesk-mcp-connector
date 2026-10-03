import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { buildContactQuery, buildTicketQuery, searchNextPage } from "../src/query.js";

describe("buildTicketQuery", () => {
  it("builds single criteria", () => {
    expect(buildTicketQuery({ status: ["Open"] })).toBe('"status:2"');
    expect(buildTicketQuery({ tag: "vip" })).toBe(`"tag:'vip'"`);
    expect(buildTicketQuery({ group_id: 9001 })).toBe('"group_id:9001"');
    expect(buildTicketQuery({ agent_id: 7001 })).toBe('"agent_id:7001"');
  });

  it("ORs values of one field and ANDs different fields", () => {
    expect(
      buildTicketQuery({ status: ["Open", "Pending"], priority: ["Urgent"], tag: "vip" }),
    ).toBe(`"(status:2 OR status:3) AND priority:4 AND tag:'vip'"`);
  });

  it("deduplicates repeated values", () => {
    expect(buildTicketQuery({ priority: ["High", "High"] })).toBe('"priority:3"');
  });

  it("builds date ranges", () => {
    expect(
      buildTicketQuery({ created_after: "2026-09-01", created_before: "2026-09-30", updated_after: "2026-09-15" }),
    ).toBe(`"created_at:>'2026-09-01' AND created_at:<'2026-09-30' AND updated_at:>'2026-09-15'"`);
  });

  it("trims string values", () => {
    expect(buildTicketQuery({ tag: "  vip  " })).toBe(`"tag:'vip'"`);
  });

  it("requires at least one criterion", () => {
    expect(() => buildTicketQuery({})).toThrow(/at least one search criterion/);
    expect(() => buildTicketQuery({ status: [] })).toThrow(ValidationError);
  });

  it.each([`vip' OR status:2`, `say "hi"`, "back\\slash"])("rejects injection-prone tag %j", (tag) => {
    expect(() => buildTicketQuery({ tag })).toThrow(/must not contain quotes or backslashes/);
  });

  it("rejects blank strings", () => {
    expect(() => buildTicketQuery({ tag: "   " })).toThrow(/tag must not be empty/);
  });

  it.each(["2026-02-30", "2026-13-01", "26-01-01", "yesterday"])("rejects invalid date %j", (d) => {
    expect(() => buildTicketQuery({ created_after: d })).toThrow(/created_after must be a valid date/);
  });

  it("rejects inverted ranges", () => {
    expect(() => buildTicketQuery({ created_after: "2026-10-01", created_before: "2026-09-01" })).toThrow(
      /created_after must not be later than created_before/,
    );
  });

  it("enforces Freshdesk's 512-character limit", () => {
    expect(() => buildTicketQuery({ tag: "a".repeat(600) })).toThrow(/too long/);
  });
});

describe("buildContactQuery", () => {
  it("builds criteria", () => {
    expect(buildContactQuery({ email: "priya.nair@example.com" })).toBe(`"email:'priya.nair@example.com'"`);
    expect(buildContactQuery({ phone: "+1-555-0101", company_id: 42, created_after: "2026-01-01" })).toBe(
      `"phone:'+1-555-0101' AND company_id:42 AND created_at:>'2026-01-01'"`,
    );
  });

  it("validates like the ticket builder", () => {
    expect(() => buildContactQuery({})).toThrow(/at least one/);
    expect(() => buildContactQuery({ email: "a'@example.com" })).toThrow(/email must not contain quotes/);
  });
});

describe("searchNextPage", () => {
  it.each([
    [1, 0, null],
    [1, 30, null],
    [1, 31, 2],
    [2, 45, null],
    [9, 1000, 10],
    [10, 1000, null],
  ])("page %i of total %i → %j", (page, total, expected) => {
    expect(searchNextPage(page, total)).toBe(expected);
  });
});
