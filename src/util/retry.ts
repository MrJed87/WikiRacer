/** Retry with bounded exponential backoff. Shared by the Wikipedia and OpenRouter clients. No DOM. */

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseMs: number;
  maxMs: number;
  /** Injectable so tests don't wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Delay before retry number `attempt` (0-based): exponential, capped, with jitter so racers de-synchronise. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp * (0.5 + random() * 0.5));
}

/**
 * Runs `attempt` until it succeeds, throws a non-retryable error, or retries are exhausted
 * (in which case the last error is thrown).
 * `retryAfterMs` lets the caller honour a server-provided delay (e.g. Retry-After).
 */
export async function withRetry<T>(
  attempt: (n: number) => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: RetryOptions,
  retryAfterMs?: (error: unknown) => number | undefined,
): Promise<T> {
  const wait = opts.sleep ?? sleep;
  for (let n = 0; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      if (n >= opts.retries || !isRetryable(error) || opts.signal?.aborted) throw error;
      const hinted = retryAfterMs?.(error);
      const delay =
        hinted !== undefined
          ? Math.min(hinted, opts.maxMs)
          : backoffDelay(n, opts.baseMs, opts.maxMs);
      await wait(delay, opts.signal);
    }
  }
}
