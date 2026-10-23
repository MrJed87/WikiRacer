/**
 * Small async helpers: a promise cache (shared between racers so each page is fetched once)
 * and a concurrency limiter. No DOM.
 */

/** LRU cache of promises. In-flight requests are shared; failures are evicted so they can be retried. */
export class PromiseCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: Promise<T>): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit) {
      // Refresh recency.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const promise = create();
    this.set(key, promise);
    promise.catch(() => {
      if (this.entries.get(key) === promise) this.entries.delete(key);
    });
    return promise;
  }
}

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export interface LimiterOptions {
  /** Pause after each task before the next one may start (politeness spacing). */
  gapMs?: number;
  /** Injectable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * At most `max` tasks run at once; the rest queue in FIFO order. With `gapMs`, a finished task's
 * slot is only handed on after that pause, so requests are spaced out as well as capped.
 */
export function createLimiter(max: number, opts: LimiterOptions = {}): Limiter {
  const gapMs = opts.gapMs ?? 0;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = (): void => {
    if (active >= max) return;
    const run = queue.shift();
    if (run) run();
  };

  const release = (): void => {
    active--;
    next();
  };

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++;
        task()
          .then(resolve, reject)
          .finally(() => {
            if (gapMs > 0) void sleep(gapMs).then(release, release);
            else release();
          });
      };
      queue.push(start);
      next();
    });
}
