/**
 * The only door to Wikipedia: all network access goes through this class so tests can swap in a fake
 * `fetch` and never hit the network. Injectable `fetch`, shared cache, bounded concurrency
 * and backoff on 429/5xx. Uses `origin=*` for CORS. No DOM.
 */
import { RACE_DEFAULTS, WIKI } from '../config';
import { PromiseCache, createLimiter, type Limiter } from '../util/async';
import { withRetry, type RetryOptions } from '../util/retry';
import { extractPage } from './extractLinks';
import { canonicalTitle } from './title';
import { WikiError, type PageData, type WikiSource } from './types';

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

/** True for https URLs on one of Wikimedia's thumbnail hosts (WIKI.imageHosts). */
export function isWikimediaImage(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && (WIKI.imageHosts as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
}

/** Api-User-Agent value: app name plus contact, as Wikimedia's User-Agent policy asks. */
export const API_USER_AGENT = `${WIKI.appName} (${WIKI.contact || 'personal use; no contact set'})`;

/**
 * The one queue every WikipediaClient uses by default, so the whole app makes one Wikipedia
 * request at a time with a pause between them, however many clients or racers there are.
 */
export const sharedWikiLimiter: Limiter = createLimiter(WIKI.maxConcurrentRequests, {
  gapMs: WIKI.requestGapMs,
});

export interface WikipediaClientOptions {
  fetch?: FetchLike;
  host?: string;
  linkCap?: number;
  summaryChars?: number;
  /** Defaults to the app-wide shared queue; tests pass their own. */
  limiter?: Limiter;
  cacheEntries?: number;
  retry?: Partial<Omit<RetryOptions, 'signal'>>;
  signal?: AbortSignal;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown, what: string): Json {
  if (!isRecord(v))
    throw new WikiError('invalid-response', `Unexpected Wikipedia response (${what})`);
  return v;
}

export interface ResolvedTitle {
  title: string;
  exists: boolean;
}

export class WikipediaClient implements WikiSource {
  private readonly fetchFn: FetchLike;
  private readonly host: string;
  private readonly linkCap: number;
  private readonly summaryChars: number;
  private readonly limit: Limiter;
  private readonly cache: PromiseCache<PageData>;
  private readonly retry: RetryOptions;

  constructor(opts: WikipediaClientOptions = {}) {
    // Resolved lazily so the global can be stubbed and so Node/browsers both work.
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.host = opts.host ?? WIKI.host;
    this.linkCap = opts.linkCap ?? RACE_DEFAULTS.linkCap;
    this.summaryChars = opts.summaryChars ?? WIKI.summaryChars;
    this.limit = opts.limiter ?? sharedWikiLimiter;
    this.cache = new PromiseCache<PageData>(opts.cacheEntries ?? 500);
    this.retry = {
      retries: opts.retry?.retries ?? 3,
      baseMs: opts.retry?.baseMs ?? 500,
      maxMs: opts.retry?.maxMs ?? 8_000,
      ...(opts.retry?.sleep ? { sleep: opts.retry.sleep } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
  }

  private requestInit(): { signal?: AbortSignal; headers: Record<string, string> } {
    const init: { signal?: AbortSignal; headers: Record<string, string> } = {
      headers: { 'Api-User-Agent': API_USER_AGENT },
    };
    if (this.retry.signal) init.signal = this.retry.signal;
    return init;
  }

  private apiUrl(params: Record<string, string | number>): string {
    const q = new URLSearchParams({ format: 'json', formatversion: '2', origin: '*' });
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    return `https://${this.host}/w/api.php?${q.toString()}`;
  }

  private async getJson(url: string): Promise<Json> {
    return this.limit(() =>
      withRetry(
        async () => {
          let res: Response;
          try {
            res = await this.fetchFn(url, this.requestInit());
          } catch (e) {
            if (this.retry.signal?.aborted) throw e;
            throw new WikiError(
              'network',
              `Could not reach Wikipedia: ${e instanceof Error ? e.message : 'network error'}`,
            );
          }
          if (res.status === 429)
            throw new WikiError('rate-limit', 'Wikipedia rate limit hit', 429);
          if (!res.ok) {
            throw new WikiError('api', `Wikipedia returned HTTP ${res.status}`, res.status);
          }
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            throw new WikiError('invalid-response', 'Wikipedia returned invalid JSON');
          }
          const json = asRecord(body, 'root');
          const err = json['error'];
          if (isRecord(err)) {
            const code = typeof err['code'] === 'string' ? err['code'] : 'unknown';
            const info = typeof err['info'] === 'string' ? err['info'] : code;
            if (code === 'missingtitle' || code === 'invalidtitle')
              throw new WikiError('not-found', info);
            if (code === 'ratelimited') throw new WikiError('rate-limit', info, 429);
            throw new WikiError('api', info);
          }
          return json;
        },
        (e) => e instanceof WikiError && e.retryable,
        this.retry,
      ),
    );
  }

  /** Fetch a page (following redirects) and extract its links. Cached and shared between racers. */
  getPage(title: string): Promise<PageData> {
    const key = canonicalTitle(title);
    return this.cache.getOrCreate(key, async () => {
      const json = await this.getJson(
        this.apiUrl({
          action: 'parse',
          page: key,
          prop: 'text',
          redirects: 1,
          disableeditsection: 1,
          disablelimitreport: 1,
          disabletoc: 1,
        }),
      );
      const parse = asRecord(json['parse'], 'parse');
      const resolved = canonicalTitle(typeof parse['title'] === 'string' ? parse['title'] : key);
      const text = parse['text'];
      if (typeof text !== 'string') throw new WikiError('invalid-response', 'Missing page text');
      const extracted = extractPage(text, {
        linkCap: this.linkCap,
        summaryChars: this.summaryChars,
        selfTitle: resolved,
      });
      const data: PageData = { title: resolved, ...extracted };
      // Redirect aliases share the resolved entry so racers arriving via different names don't refetch.
      if (resolved !== key) this.cache.set(resolved, Promise.resolve(data));
      return data;
    });
  }

  /** Thumbnail URL per title (null = the article has no lead image). Shared across races. */
  private readonly thumbs = new Map<string, string | null>();

  /**
   * Lead-image thumbnails for many titles, batched 50 per request (the API maximum) and cached.
   * Titles are expected to be canonical (as they are in the race graph); redirects are still
   * followed so an alias gets its target's image.
   */
  async getThumbnails(titles: readonly string[], size = 96): Promise<Map<string, string | null>> {
    const wanted = [...new Set(titles.map(canonicalTitle))].filter((t) => t.length > 0);
    const missing = wanted.filter((t) => !this.thumbs.has(t));
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const json = await this.getJson(
        this.apiUrl({
          action: 'query',
          prop: 'pageimages',
          piprop: 'thumbnail',
          pithumbsize: size,
          pilimit: 50,
          redirects: 1,
          titles: batch.join('|'),
        }),
      );
      const query = asRecord(json['query'], 'query');
      // Map each asked title through normalisation and redirects to the title the API answers with.
      const alias = new Map<string, string>();
      for (const key of ['normalized', 'redirects']) {
        const list = query[key];
        if (!Array.isArray(list)) continue;
        for (const r of list) {
          if (isRecord(r) && typeof r['from'] === 'string' && typeof r['to'] === 'string') {
            alias.set(canonicalTitle(r['from']), canonicalTitle(r['to']));
          }
        }
      }
      const found = new Map<string, string>();
      const pages = query['pages'];
      if (Array.isArray(pages)) {
        for (const page of pages) {
          if (!isRecord(page) || typeof page['title'] !== 'string') continue;
          const thumb = page['thumbnail'];
          const src = isRecord(thumb) ? thumb['source'] : undefined;
          // Only Wikimedia's own image hosts, which are what the CSP allows.
          if (typeof src === 'string' && isWikimediaImage(src)) {
            found.set(canonicalTitle(page['title']), src);
          }
        }
      }
      for (const t of batch) {
        let resolved = t;
        for (let hops = 0; hops < 3 && alias.has(resolved); hops++) resolved = alias.get(resolved)!;
        this.thumbs.set(t, found.get(resolved) ?? null);
      }
    }
    return new Map(wanted.map((t) => [t, this.thumbs.get(t) ?? null]));
  }

  /**
   * Article (main namespace) titles linked from a page, e.g. a project list page. Uses the API's
   * link table rather than the HTML, so list layout doesn't matter. Missing pages give [].
   */
  async linkedArticles(pageTitle: string): Promise<string[]> {
    let json: Json;
    try {
      json = await this.getJson(
        this.apiUrl({ action: 'parse', page: pageTitle, prop: 'links', redirects: 1 }),
      );
    } catch (e) {
      if (e instanceof WikiError && e.kind === 'not-found') return [];
      throw e;
    }
    const parse = isRecord(json['parse']) ? json['parse'] : {};
    const links = parse['links'];
    if (!Array.isArray(links)) return [];
    const out: string[] = [];
    for (const l of links) {
      if (!isRecord(l) || l['ns'] !== 0 || l['exists'] === false) continue;
      if (typeof l['title'] === 'string') out.push(canonicalTitle(l['title']));
    }
    return out;
  }

  /** Normalise a title and follow redirects, without fetching the body. */
  async resolveTitle(title: string): Promise<ResolvedTitle> {
    const json = await this.getJson(
      this.apiUrl({ action: 'query', titles: canonicalTitle(title), redirects: 1 }),
    );
    const pages = asRecord(json['query'], 'query')['pages'];
    const first: unknown = Array.isArray(pages) ? pages[0] : undefined;
    const page = asRecord(first, 'pages[0]');
    const resolved =
      typeof page['title'] === 'string' ? canonicalTitle(page['title']) : canonicalTitle(title);
    const exists = page['missing'] !== true && page['invalid'] !== true;
    return { title: resolved, exists };
  }

  /** Prefix autocomplete for the target field. */
  async search(prefix: string, limit = 8): Promise<string[]> {
    const q = prefix.trim();
    if (q.length === 0) return [];
    const url = this.apiUrl({ action: 'opensearch', search: q, limit, namespace: 0 });
    // opensearch returns a bare array, so it can't go through getJson's object check.
    const body = await this.limit(() =>
      withRetry(
        async () => {
          const res = await this.fetchFn(url, this.requestInit()).catch((e: unknown) => {
            if (this.retry.signal?.aborted) throw e;
            throw new WikiError('network', 'Could not reach Wikipedia');
          });
          if (res.status === 429)
            throw new WikiError('rate-limit', 'Wikipedia rate limit hit', 429);
          if (!res.ok)
            throw new WikiError('api', `Wikipedia returned HTTP ${res.status}`, res.status);
          return (await res.json()) as unknown;
        },
        (e) => e instanceof WikiError && e.retryable,
        this.retry,
      ),
    );
    const titles: unknown = Array.isArray(body) ? body[1] : undefined;
    return Array.isArray(titles) ? titles.filter((t): t is string => typeof t === 'string') : [];
  }

  /** Random main-namespace, non-redirect article titles. */
  async randomTitles(count: number): Promise<string[]> {
    const json = await this.getJson(
      this.apiUrl({
        action: 'query',
        list: 'random',
        rnnamespace: 0,
        rnlimit: count,
        rnfilterredir: 'nonredirects',
      }),
    );
    const random = asRecord(json['query'], 'query')['random'];
    if (!Array.isArray(random)) return [];
    const out: string[] = [];
    for (const r of random) {
      if (isRecord(r) && typeof r['title'] === 'string') out.push(canonicalTitle(r['title']));
    }
    return out;
  }

  /**
   * Average daily views over the last ~30 days, via the PageViewInfo extension (stays on
   * *.wikipedia.org so the CSP needn't allow another host). Missing days count as zero views.
   */
  async averageDailyViews(titles: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (titles.length === 0) return result;
    const json = await this.getJson(
      this.apiUrl({
        action: 'query',
        prop: 'pageviews',
        pvipdays: 30,
        titles: titles.map(canonicalTitle).join('|'),
      }),
    );
    const pages = asRecord(json['query'], 'query')['pages'];
    if (!Array.isArray(pages)) return result;
    for (const p of pages) {
      if (!isRecord(p) || typeof p['title'] !== 'string') continue;
      const views = p['pageviews'];
      let sum = 0;
      let days = 0;
      if (isRecord(views)) {
        for (const v of Object.values(views)) {
          days++;
          if (typeof v === 'number') sum += v;
        }
      }
      result.set(canonicalTitle(p['title']), days === 0 ? 0 : sum / days);
    }
    return result;
  }

  /** Number of main-namespace pages linking to `title`, counting up to `max`. */
  async incomingLinkCount(title: string, max = 10): Promise<number> {
    const json = await this.getJson(
      this.apiUrl({
        action: 'query',
        list: 'backlinks',
        bltitle: canonicalTitle(title),
        bllimit: max,
        blnamespace: 0,
      }),
    );
    const backlinks = asRecord(json['query'], 'query')['backlinks'];
    return Array.isArray(backlinks) ? backlinks.length : 0;
  }
}
