import { writeFileSync } from "node:fs";
import { listToolDefinitions, renderToolDocs, TOOL_DOCS_PATH } from "./tool-docs.js";

writeFileSync(TOOL_DOCS_PATH, renderToolDocs(await listToolDefinitions()));
console.error(`wrote ${TOOL_DOCS_PATH}`);
