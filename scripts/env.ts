/** Loads ./.env into process.env for dev scripts (the MCP server itself gets env from its host). */
export function loadEnv(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // no .env — rely on the real environment; loadConfig reports what is missing
  }
}
