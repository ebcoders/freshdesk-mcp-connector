#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FreshdeskClient } from "./client.js";
import { loadConfig, loadTransportConfig, type Config, type TransportConfig } from "./config.js";
import { ConfigError } from "./errors.js";
import { startHttpServer } from "./http.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  let config: Config;
  let transport: TransportConfig;
  try {
    config = loadConfig();
    transport = loadTransportConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[freshdesk] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const client = new FreshdeskClient(config);
  if (transport.kind === "http") {
    const { url } = await startHttpServer(client, transport);
    console.error(`[freshdesk] ${SERVER_NAME} ${SERVER_VERSION} listening on ${url}/mcp for ${config.baseUrl}`);
    return;
  }

  await createServer(client).connect(new StdioServerTransport());
  console.error(`[freshdesk] ${SERVER_NAME} ${SERVER_VERSION} ready on stdio for ${config.baseUrl}`);
}

main().catch((err: unknown) => {
  console.error(`[freshdesk] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
