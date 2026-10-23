/** Central constants. Anything tunable lives here so fairness settings stay in one place. */

export const APP_NAME = 'Wikipedia Graph Race';

/** Race defaults. Every racer receives exactly these values (fairness rule). */
export const RACE_DEFAULTS = {
  /** Maximum clicks (including `back` moves and wasted invalid picks) per model. */
  maxSteps: 30,
  /** Maximum links offered to a model per page. */
  linkCap: 150,
  /** Sampling temperature sent to every model. */
  temperature: 0.2,
  /** Revisiting the same article this many times marks a model as circling. */
  circlingThreshold: 3,
  /** Visits to one page before it stops being offered to that racer. */
  maxVisitsPerPage: 3,
  /** Per-model spend cap in USD; the agent stops when exceeded. */
  budgetUsd: 0.5,
  /** Per-model total token cap. */
  budgetTokens: 400_000,
  /** Min and max racers. */
  minModels: 2,
  maxModels: 6,
  /** Delay between steps in ms (0 = as fast as the models answer). */
  stepDelayMs: 0,
  /** Keep racing after the first arrival so you can watch everyone finish (or circle). */
  stopOnFirstArrival: false,
  /** Lockstep rounds keep the shared one-at-a-time Wikipedia queue fair between racers. */
  lockstep: true,
  /** Low effort stops reasoning models spending the whole reply budget on thinking. */
  reasoningEffort: 'low',
  /** Reply-token cap per model call (thinking included on most providers). */
  maxOutputTokens: 4_000,
} as const;

/** Allowed ranges for user-editable race settings (setup form and share links). */
export const RACE_LIMITS = {
  maxSteps: { min: 5, max: 100 },
  linkCap: { min: 20, max: 300 },
  temperature: { min: 0, max: 1 },
  circlingThreshold: { min: 2, max: 10 },
  maxVisitsPerPage: { min: 1, max: 20 },
  maxOutputTokens: { min: 256, max: 32_000 },
} as const;

export type LimitedSetting = keyof typeof RACE_LIMITS;

/** Clamps a setting into its range; non-numbers fall back to the default. */
export function clampSetting(key: LimitedSetting, value: number): number {
  if (!Number.isFinite(value)) return RACE_DEFAULTS[key];
  const { min, max } = RACE_LIMITS[key];
  return Math.min(max, Math.max(min, value));
}

export const WIKI = {
  /** Language edition used for all requests. */
  host: 'en.wikipedia.org',
  /** Characters of lead text shown to models. */
  summaryChars: 600,
  /**
   * Wikimedia's robot policy asks for "a single connection, with a small delay (100ms or so)
   * between requests". Every Wikipedia request in the app (setup, races, thumbnails) shares one
   * queue with these settings.
   */
  maxConcurrentRequests: 1,
  requestGapMs: 100,
  /**
   * Hosts allowed to serve article thumbnails. Wikimedia moved API thumbnails from
   * upload.wikimedia.org to thumb.wikimedia.org; keep both, and keep the CSP img-src in sync.
   */
  imageHosts: ['upload.wikimedia.org', 'thumb.wikimedia.org'],
  /**
   * `appName` and `contact` identify the app to Wikimedia via the Api-User-Agent header (browsers
   * can't set User-Agent). Wikimedia asks for a contact (a URL or email); fill in `contact` if you
   * host your own copy widely.
   */
  appName: 'WikipediaGraphRace/0.1',
  contact: 'https://github.com/MrJed87/WikiRacer',
  /** Obscure start picker thresholds. */
  startPicker: {
    maxAvgDailyViews: 100,
    minOutgoingLinks: 15,
    minIncomingLinks: 3,
    maxAttempts: 20,
  },
} as const;

export const OPENROUTER = {
  baseUrl: 'https://openrouter.ai/api/v1',
  requestTimeoutMs: 60_000,
  /** Output cap per answer. Generous so reasoning models still have room to reply after thinking. */
  maxOutputTokens: 4_000,
  maxRetries: 3,
  /** Base for exponential backoff on 429/5xx. */
  backoffBaseMs: 1_000,
  backoffMaxMs: 15_000,
  /** Attribution headers recommended by OpenRouter. */
  appTitle: 'Wikipedia Graph Race',
} as const;

export const STORAGE_KEYS = {
  apiKey: 'wgr.apiKey',
  rememberKey: 'wgr.rememberKey',
  settings: 'wgr.settings',
  wikiCache: 'wgr.wikiCache',
  thumbnails: 'wgr.thumbnails',
  costHistory: 'wgr.costHistory',
  customGroup: 'wgr.customGroup',
} as const;
