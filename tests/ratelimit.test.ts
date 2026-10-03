import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

function headers(remaining: number, total = 50): Headers {
  return new Headers({ "X-RateLimit-Total": String(total), "X-RateLimit-Remaining": String(remaining) });
}

function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("RateLimiter", () => {
  it("records budget from headers", () => {
    const rl = new RateLimiter({ maxConcurrency: 2 });
    expect(rl.remaining).toBeNull();
    rl.update(headers(42));
    expect(rl.remaining).toBe(42);
    expect(rl.total).toBe(50);
    expect(rl.isLow).toBe(false);
    rl.update(headers(4));
    expect(rl.isLow).toBe(true);
  });

  it("ignores missing or garbage headers", () => {
    const rl = new RateLimiter({ maxConcurrency: 2 });
    rl.update(headers(10));
    rl.update(new Headers({ "X-RateLimit-Remaining": "lots" }));
    expect(rl.remaining).toBe(10);
  });

  it("treats a 429 without headers as an exhausted budget", () => {
    const rl = new RateLimiter({ maxConcurrency: 2 });
    rl.update(headers(10));
    rl.update(new Headers(), 429);
    expect(rl.remaining).toBe(0);
  });

  it("does not delay while budget is healthy", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ maxConcurrency: 2, now: clock.now, sleep: clock.sleep });
    rl.update(headers(40));
    for (let i = 0; i < 5; i++) (await rl.acquire())();
    expect(clock.sleeps).toEqual([]);
  });

  it("paces request starts at the sustained rate when budget is low", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ maxConcurrency: 2, now: clock.now, sleep: clock.sleep });
    rl.update(headers(4, 50)); // 8% < 10% → pace at 60000/50 = 1200ms
    expect(rl.paceMs).toBe(1200);
    (await rl.acquire())();
    (await rl.acquire())();
    (await rl.acquire())();
    expect(clock.sleeps).toEqual([1200, 1200]);
  });

  it("holds every request until a cooldown has passed", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ maxConcurrency: 2, now: clock.now, sleep: clock.sleep });
    rl.pause(5000);
    expect(rl.cooldownRemainingMs).toBe(5000);
    (await rl.acquire())();
    (await rl.acquire())();
    expect(clock.sleeps).toEqual([5000]);
    expect(rl.cooldownRemainingMs).toBe(0);
  });

  it("keeps waiting if the cooldown is extended while it sleeps", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      maxConcurrency: 1,
      now: () => now,
      sleep: async (ms) => {
        if (sleeps.length === 0) rl.pause(ms + 4000); // another request hits a 429 meanwhile
        sleeps.push(ms);
        now += ms;
      },
    });
    rl.pause(1000);
    (await rl.acquire())();
    expect(sleeps).toEqual([1000, 4000]);
  });

  it("refuses to wait longer than the caller's maximum", async () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ maxConcurrency: 1, now: clock.now, sleep: clock.sleep });
    rl.pause(5000);
    await expect(rl.acquire(4000)).rejects.toMatchObject({ name: "RateLimitedError", retryAfterSeconds: 5 });
    expect(clock.sleeps).toEqual([]);
    (await rl.acquire(5000))(); // within the limit: waits, and the refused call left no slot taken
    expect(clock.sleeps).toEqual([5000]);
  });

  it("never shortens an existing cooldown", () => {
    const clock = fakeClock();
    const rl = new RateLimiter({ maxConcurrency: 1, now: clock.now, sleep: clock.sleep });
    rl.pause(5000);
    rl.pause(1000);
    expect(rl.cooldownRemainingMs).toBe(5000);
  });

  it("caps concurrency and hands slots to waiters in order", async () => {
    const rl = new RateLimiter({ maxConcurrency: 2 });
    const releaseA = await rl.acquire();
    await rl.acquire();
    let thirdStarted = false;
    const third = rl.acquire().then((release) => {
      thirdStarted = true;
      return release;
    });
    await flush();
    expect(thirdStarted).toBe(false);
    releaseA();
    await third;
    expect(thirdStarted).toBe(true);
  });

  it("release is idempotent", async () => {
    const rl = new RateLimiter({ maxConcurrency: 1 });
    const release = await rl.acquire();
    release();
    release();
    const a = await rl.acquire();
    let bStarted = false;
    void rl.acquire().then(() => (bStarted = true));
    await flush();
    expect(bStarted).toBe(false); // double release did not create a phantom slot
    a();
  });
});
