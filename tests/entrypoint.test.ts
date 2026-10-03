import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("server entry point", () => {
  it("exits with a clear message when configuration is missing", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("FRESHDESK_DOMAIN is not set");
    expect(res.stdout).toBe(""); // stdout is reserved for the MCP protocol
  });

  it("rejects non-Freshdesk domains without echoing the key", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { PATH: process.env.PATH ?? "", FRESHDESK_DOMAIN: "evil.com", FRESHDESK_API_KEY: "super-secret" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/FRESHDESK_DOMAIN must be a Freshdesk subdomain/);
    expect(res.stderr).not.toContain("super-secret");
  });

  it("refuses HTTP mode without a token", () => {
    const res = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { PATH: process.env.PATH ?? "", FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "k", MCP_TRANSPORT: "http" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("MCP_HTTP_TOKEN is required");
  });

  it("starts in HTTP mode and serves the health check", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        FRESHDESK_DOMAIN: "acme",
        FRESHDESK_API_KEY: "k",
        MCP_TRANSPORT: "http",
        MCP_HTTP_TOKEN: "entrypoint-test-token-123",
        PORT: "0",
      },
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          const match = stderr.match(/listening on (http:\/\/\S+)/);
          if (match) resolve(match[1]!);
        });
        child.on("exit", () => reject(new Error(`exited early: ${stderr}`)));
        setTimeout(() => reject(new Error(`timeout: ${stderr}`)), 15_000);
      });
      const res = await fetch(new URL("/healthz", url));
      expect(res.status).toBe(200);
    } finally {
      child.kill();
    }
  }, 20_000);
});
