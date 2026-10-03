import { RateLimitedError } from "./errors.js";

export interface RateLimiterOptions {
  maxConcurrency: number;
  /** Fraction of the per-minute budget below which requests are paced. Default 0.1. */
  lowWatermark?: number;
  /** Length of Freshdesk's rate-limit window. Default 60s. */
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function toInt(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Client-side guard for Freshdesk's account-wide per-minute limit.
 * - caps in-flight requests (agents can fire tool calls in parallel)
 * - once less than `lowWatermark` of the budget remains, spaces request starts at the
 *   plan's sustained rate (window / total) instead of letting a burst exhaust it.
 * - after a 429, holds every request until Retry-After has passed (see `pause`).
 */
export class RateLimiter {
  private readonly maxConcurrency: number;
  private readonly lowWatermark: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private nextSlotAt = 0;
  private blockedUntil = 0;
  private _remaining: number | null = null;
  private _total: number | null = null;

  constructor(opts: RateLimiterOptions) {
    this.maxConcurrency = opts.maxConcurrency;
    this.lowWatermark = opts.lowWatermark ?? 0.1;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get remaining(): number | null {
    return this._remaining;
  }

  get total(): number | null {
    return this._total;
  }

  get isLow(): boolean {
    return this._remaining !== null && !!this._total && this._remaining / this._total < this.lowWatermark;
  }

  /** Time left before Freshdesk will accept requests again after a 429, in ms. */
  get cooldownRemainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Holds all requests for `ms` (Freshdesk's Retry-After applies to the whole account). */
  pause(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  get paceMs(): number {
    return this._total ? Math.ceil(this.windowMs / this._total) : 0;
  }

  /**
   * Waits for a concurrency slot, any 429 cooldown and pacing, then returns the release function.
   * Throws RateLimitedError instead of waiting out a cooldown longer than `maxWaitMs`.
   */
  async acquire(maxWaitMs = Infinity): Promise<() => void> {
    this.refuseLongCooldown(maxWaitMs);
    if (this.active < this.maxConcurrency) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve)); // slot is handed over by release()

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };

    try {
      // Re-check after each sleep: another request may have hit a 429 and extended the cooldown.
      for (let cooldown = this.cooldownRemainingMs; cooldown > 0; cooldown = this.cooldownRemainingMs) {
        this.refuseLongCooldown(maxWaitMs);
        await this.sleep(cooldown);
      }
    } catch (err) {
      release();
      throw err;
    }

    if (this.isLow) {
      const now = this.now();
      const startAt = Math.max(now, this.nextSlotAt);
      this.nextSlotAt = startAt + this.paceMs;
      if (startAt > now) await this.sleep(startAt - now);
    }
    return release;
  }

  private refuseLongCooldown(maxWaitMs: number): void {
    const cooldown = this.cooldownRemainingMs;
    if (cooldown > maxWaitMs) throw new RateLimitedError(Math.ceil(cooldown / 1000));
  }

  update(headers: Headers, status?: number): void {
    const total = toInt(headers.get("x-ratelimit-total"));
    const remaining = toInt(headers.get("x-ratelimit-remaining"));
    if (total !== null) this._total = total;
    if (remaining !== null) this._remaining = remaining;
    else if (status === 429) this._remaining = 0;
  }
}
