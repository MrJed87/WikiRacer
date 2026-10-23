/**
 * Requests article thumbnails for graph nodes in small debounced batches, so a burst of new nodes
 * becomes one Wikipedia request. No DOM: the image itself is handled by the renderer via `apply`.
 */

export interface ThumbnailSource {
  getThumbnails(titles: readonly string[]): Promise<Map<string, string | null>>;
}

export interface ThumbnailLoaderOptions {
  source: ThumbnailSource;
  /** Called once per title that has a thumbnail. */
  apply: (title: string, url: string) => void;
  /** Wait this long after the last request before fetching, to batch bursts. */
  delayMs?: number;
  /** Injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
}

export class ThumbnailLoader {
  /** Titles already fetched or in flight (never refetched unless the fetch failed). */
  private readonly requested = new Set<string>();
  private readonly pending = new Set<string>();
  private scheduled = false;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;

  constructor(private readonly opts: ThumbnailLoaderOptions) {
    this.delayMs = opts.delayMs ?? 400;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  }

  /** Queue titles; ones already known are ignored. */
  request(titles: Iterable<string>): void {
    for (const t of titles) {
      if (this.requested.has(t)) continue;
      this.requested.add(t);
      this.pending.add(t);
    }
    if (this.pending.size > 0 && !this.scheduled) {
      this.scheduled = true;
      this.setTimer(() => void this.flush(), this.delayMs);
    }
  }

  /** Fetch everything queued now. Resolves once the results have been applied. */
  async flush(): Promise<void> {
    this.scheduled = false;
    const batch = [...this.pending];
    this.pending.clear();
    if (batch.length === 0) return;
    try {
      const found = await this.opts.source.getThumbnails(batch);
      for (const [title, url] of found) if (url) this.opts.apply(title, url);
    } catch {
      // Thumbnails are decoration: forget these titles so a later request retries them.
      for (const t of batch) this.requested.delete(t);
    }
  }
}
