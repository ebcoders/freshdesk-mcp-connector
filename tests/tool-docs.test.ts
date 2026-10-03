import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listToolDefinitions, renderToolDocs, TOOL_DOCS_PATH } from "../scripts/tool-docs.js";

describe("docs/TOOLS.md", () => {
  it("is up to date with the registered tools (run `npm run docs:tools`)", async () => {
    const expected = renderToolDocs(await listToolDefinitions());
    expect(readFileSync(TOOL_DOCS_PATH, "utf8")).toBe(expected);
  });

  it("documents every tool with an example", async () => {
    const md = renderToolDocs(await listToolDefinitions());
    for (const name of ["list_tickets", "get_ticket", "list_ticket_conversations", "search_tickets", "get_contact", "search_contacts"]) {
      expect(md).toContain(`## \`${name}\``);
    }
    expect(md).not.toContain("_No example_");
  });
});
