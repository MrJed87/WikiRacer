import { describe, expect, it } from 'vitest';
import { PromiseCache, createLimiter } from '../src/util/async';
import { backoffDelay, withRetry } from '../src/util/retry';

describe('PromiseCache', () => {
  it('dedupes in-flight work and evicts failures', async () => {
    const cache = new PromiseCache<number>(10);
    let calls = 0;
    const make = () => cache.getOrCreate('k', async () => ++calls);
    expect(await Promise.all([make(), make()])).toEqual([1, 1]);

    let fails = 0;
    const bad = () =>
      cache.getOrCreate('bad', async () => {
        fails++;
        throw new Error('x');
      });
    await expect(bad()).rejects.toThrow();
    await expect(bad()).rejects.toThrow();
    expect(fails).toBe(2);
  });

  it('evicts the least recently used entry', async () => {
    const cache = new PromiseCache<number>(2);
    await cache.getOrCreate('a', async () => 1);
    await cache.getOrCreate('b', async () => 2);
    await cache.getOrCreate('a', async () => 99); // refresh a
    await cache.getOrCreate('c', async () => 3);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });
});

describe('createLimiter', () => {
  it('never exceeds the concurrency limit and runs everything', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return 1;
      });
    const results = await Promise.all(Array.from({ length: 8 }, task));
    expect(results).toHaveLength(8);
    expect(peak).toBe(2);
  });

  it('keeps going after a task fails', async () => {
    const limit = createLimiter(1);
    const bad = limit(async () => {
      throw new Error('boom');
    });
    const good = limit(async () => 'ok');
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('ok');
  });
});

describe('withRetry', () => {
  const opts = { retries: 3, baseMs: 100, maxMs: 1000 };

  it('backs off between retries and returns the first success', async () => {
    const delays: number[] = [];
    let n = 0;
    const result = await withRetry(
      async () => {
        if (++n < 3) throw new Error('flaky');
        return 'done';
      },
      () => true,
      {
        ...opts,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );
    expect(result).toBe('done');
    expect(delays).toHaveLength(2);
  });

  it('does not retry non-retryable errors', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error('fatal');
        },
        () => false,
        opts,
      ),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });

  it('throws the last error after exhausting retries', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error(`e${n}`);
        },
        () => true,
        { ...opts, retries: 2, sleep: async () => {} },
      ),
    ).rejects.toThrow('e3');
  });

  it('honours a server hint, capped at maxMs', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw new Error('x');
        return 1;
      },
      () => true,
      {
        ...opts,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
      () => 60_000,
    );
    expect(delays).toEqual([1000]);
  });

  it('computes capped exponential delays with jitter', () => {
    expect(backoffDelay(0, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(10, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(2, 100, 1000, () => 0)).toBe(200);
  });
});
