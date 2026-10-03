/** Base class for every error the connector reports to an agent. Messages must never contain credentials. */
export class FreshdeskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthError extends FreshdeskError {}
export class PermissionError extends FreshdeskError {}
export class NotFoundError extends FreshdeskError {}
export class ValidationError extends FreshdeskError {}
export class UpstreamError extends FreshdeskError {}

export class RateLimitedError extends FreshdeskError {
  constructor(readonly retryAfterSeconds: number) {
    super(`Rate limited by Freshdesk — retry after ${retryAfterSeconds} seconds`, 429);
  }
}

/** Invalid or missing configuration; fatal at startup. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
