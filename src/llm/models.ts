/** OpenRouter model catalogue: fetch, normalise, search. No DOM. */
import { OPENROUTER } from '../config';
import { LlmError } from './types';
import type { LlmFetch } from './openrouter';

export interface ModelInfo {
  id: string;
  name: string;
  /** Advertises `tools` support. Models without it use the JSON fallback. */
  supportsTools: boolean;
  /** USD per million tokens; null when the catalogue doesn't say. */
  promptPerMTok: number | null;
  completionPerMTok: number | null;
  contextLength: number | null;
  free: boolean;
  /**
   * Artificial Analysis Intelligence Index from OpenRouter's catalogue (roughly 0-60 today), or
   * undefined/null when the model hasn't been scored. Aliases inherit their target's score.
   */
  intelligence?: number | null;
  /** For `~vendor/...-latest` aliases: the model id it currently points to. */
  aliasOf?: string;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** OpenRouter prices are strings of USD per token. */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n * 1_000_000 : null;
}

export function normaliseModels(body: unknown): ModelInfo[] {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) throw new LlmError('bad-response', 'Unexpected model list response');
  const out: ModelInfo[] = [];
  for (const m of data) {
    if (!isRecord(m) || typeof m['id'] !== 'string') continue;
    const arch = isRecord(m['architecture']) ? m['architecture'] : {};
    const outputs = arch['output_modalities'];
    // Only text-out chat models can play. Skip image/audio generators.
    if (Array.isArray(outputs) && !(outputs.includes('text') && outputs.length === 1)) continue;
    const params = m['supported_parameters'];
    const pricing = isRecord(m['pricing']) ? m['pricing'] : {};
    const promptPerMTok = perMillion(pricing['prompt']);
    const completionPerMTok = perMillion(pricing['completion']);
    const ctx = m['context_length'];
    out.push({
      id: m['id'],
      name: typeof m['name'] === 'string' ? m['name'] : m['id'],
      supportsTools: Array.isArray(params) && params.includes('tools'),
      promptPerMTok,
      completionPerMTok,
      contextLength: typeof ctx === 'number' ? ctx : null,
      free: promptPerMTok === 0 && completionPerMTok === 0,
      intelligence: intelligenceIndex(m['benchmarks']),
      ...(aliasTarget(m['alias_target']) ? { aliasOf: aliasTarget(m['alias_target'])! } : {}),
    });
  }
  // Aliases ("~z-ai/glm-flash-latest") carry no scores of their own; borrow their target's.
  const byId = new Map(out.map((x) => [x.id, x]));
  for (const x of out) {
    if (x.aliasOf && (x.intelligence ?? null) === null) {
      x.intelligence = byId.get(x.aliasOf)?.intelligence ?? null;
    }
  }
  return out;
}

function intelligenceIndex(benchmarks: unknown): number | null {
  if (!isRecord(benchmarks)) return null;
  const aa = benchmarks['artificial_analysis'];
  const v = isRecord(aa) ? aa['intelligence_index'] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function aliasTarget(v: unknown): string | undefined {
  return isRecord(v) && typeof v['slug'] === 'string' ? v['slug'] : undefined;
}

/**
 * The account-filtered list (GET /models/user) comes without benchmark scores, so scores and alias
 * targets are copied from the public catalogue by model id. Returns new objects.
 */
export function enrichFromCatalogue(
  models: readonly ModelInfo[],
  catalogue: readonly ModelInfo[],
): ModelInfo[] {
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const out = models.map((m) => {
    const ref = byId.get(m.id);
    if (!ref) return { ...m };
    return {
      ...m,
      intelligence:
        typeof m.intelligence === 'number' ? m.intelligence : (ref.intelligence ?? null),
      ...((m.aliasOf ?? ref.aliasOf) ? { aliasOf: (m.aliasOf ?? ref.aliasOf)! } : {}),
    };
  });
  // An alias whose own entry had no score still borrows its target's (from either list).
  const scores = new Map<string, number>();
  for (const m of [...catalogue, ...out]) {
    if (typeof m.intelligence === 'number') scores.set(m.id, m.intelligence);
  }
  for (const m of out) {
    if (m.aliasOf && typeof m.intelligence !== 'number')
      m.intelligence = scores.get(m.aliasOf) ?? null;
  }
  return out;
}

/** Models at or above `min` intelligence; unscored models are left out while a minimum is set. */
export function filterByIntelligence(
  models: readonly ModelInfo[],
  min: number | null,
): ModelInfo[] {
  if (min === null || !Number.isFinite(min) || min <= 0) return [...models];
  return models.filter((m) => typeof m.intelligence === 'number' && m.intelligence >= min);
}

/** The model list is public, so no key is sent. */
export async function fetchModels(
  opts: { fetch?: LlmFetch; baseUrl?: string; signal?: AbortSignal; apiKey?: string } = {},
): Promise<ModelInfo[]> {
  const fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  // With a key, ask for the list filtered by the account's provider preferences, privacy settings
  // and guardrails (GET /models/user), so the picker only offers models that can actually run.
  const key = opts.apiKey?.trim();
  const path = key ? '/models/user' : '/models';
  const init: RequestInit = {};
  if (opts.signal) init.signal = opts.signal;
  if (key) init.headers = { Authorization: `Bearer ${key}` };
  let res: Response;
  try {
    res = await fetchFn(`${opts.baseUrl ?? OPENROUTER.baseUrl}${path}`, init);
  } catch {
    throw new LlmError('network', 'Could not load the model list from OpenRouter');
  }
  if (!res.ok)
    throw new LlmError('server', `Model list request failed (HTTP ${res.status})`, {
      status: res.status,
    });
  return normaliseModels(await res.json());
}

export type ModelSort = 'name' | 'intelligence' | 'price';

/**
 * Orders models for the picker. Models missing the sort value (no score, no price) go last.
 * - name: tool-capable first, then A-Z.
 * - intelligence: highest score first.
 * - price: cheapest per click first (real cost on this browser when known).
 */
export function sortModels(
  models: readonly ModelInfo[],
  mode: ModelSort,
  observedCost?: (id: string) => number | undefined,
): ModelInfo[] {
  const byName = (a: ModelInfo, b: ModelInfo) =>
    Number(b.supportsTools) - Number(a.supportsTools) || a.name.localeCompare(b.name);
  const out = [...models];
  if (mode === 'intelligence') {
    const v = (m: ModelInfo) => (typeof m.intelligence === 'number' ? m.intelligence : -Infinity);
    out.sort((a, b) => v(b) - v(a) || byName(a, b));
  } else if (mode === 'price') {
    const v = (m: ModelInfo) => (m.free ? 0 : (observedCost?.(m.id) ?? estimatedStepCost(m)));
    out.sort((a, b) => v(a) - v(b) || byName(a, b));
  } else {
    out.sort(byName);
  }
  return out;
}

/** Every whitespace-separated term must appear in the id or name. Tool-capable models sort first. */
export function searchModels(models: readonly ModelInfo[], query: string, limit = 50): ModelInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  matches.sort(
    (a, b) => Number(b.supportsTools) - Number(a.supportsTools) || a.name.localeCompare(b.name),
  );
  return matches.slice(0, limit);
}

/** Curated flagship IDs, matched exactly so a preset never silently picks a different variant. */
export const FLAGSHIP_IDS = [
  'anthropic/claude-sonnet-5.5',
  'openai/gpt-6.1-sol',
  'google/gemini-4-argon',
  'deepseek/deepseek-v4-pro-0813',
] as const;

/** How many models a preset selects. */
export const PRESET_SIZE = 4;

/**
 * A model's family: vendor plus the first word of the model name, so `google/gemma-4-27b` and
 * `google/gemma-4-9b` are one family ("google/gemma") but `google/gemini-…` is another.
 */
export function modelFamily(id: string): string {
  const [vendor = '', slug = ''] = id.toLowerCase().replace(/^~/, '').split('/');
  const word = /^[a-z]+/.exec(slug)?.[0] ?? slug;
  return `${vendor}/${word}`;
}

/** Variants that aren't normal chat endpoints for a live race (async batch, etc.). */
function isRaceableVariant(id: string): boolean {
  const variant = id.split(':')[1];
  return variant === undefined || variant === 'free';
}

/** Rough cost of one race step: about 3,000 prompt tokens and 300 completion tokens. */
export function estimatedStepCost(m: ModelInfo): number {
  return ((m.promptPerMTok ?? Infinity) * 3_000 + (m.completionPerMTok ?? Infinity) * 300) / 1e6;
}

/** First `n` models in order, skipping any whose family is already taken. */
export function pickDistinctFamilies(models: readonly ModelInfo[], n = PRESET_SIZE): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of models) {
    // An alias belongs to the family of the model it points to.
    const fam = modelFamily(m.aliasOf ?? m.id);
    if (seen.has(fam)) continue;
    seen.add(fam);
    out.push(m);
    if (out.length === n) break;
  }
  return out;
}

export type PresetName = 'flagship' | 'free' | 'fast';

/**
 * Picks preset racers from the models this account can run (`available`), one per family.
 * - fast: the cheapest paid models: real cost per click on this browser where known, else the
 *   estimate from list prices.
 * - free: free models (tool-capable first).
 * - flagship: the curated flagships the account can run, topped up with the priciest remaining
 *   families under a sanity cap so a single expensive model can't eat the budget.
 */
export function choosePreset(
  name: PresetName,
  available: readonly ModelInfo[],
  /** Real average cost per call on this browser, when known; preferred over list prices. */
  observedCost?: (id: string) => number | undefined,
): ModelInfo[] {
  const cost = (m: ModelInfo): number => observedCost?.(m.id) ?? estimatedStepCost(m);
  const usable = available.filter(
    (m) => isRaceableVariant(m.id) && (m.contextLength === null || m.contextLength >= 16_000),
  );
  const toolsFirst = (a: ModelInfo, b: ModelInfo) =>
    Number(b.supportsTools) - Number(a.supportsTools);

  if (name === 'fast') {
    const paid = usable.filter((m) => !m.free && Number.isFinite(cost(m)));
    paid.sort((a, b) => cost(a) - cost(b) || toolsFirst(a, b));
    return pickDistinctFamilies(paid);
  }
  if (name === 'free') {
    return pickDistinctFamilies(usable.filter((m) => m.free).sort(toolsFirst));
  }
  const curated = FLAGSHIP_IDS.flatMap((id) => usable.filter((m) => m.id === id));
  const topUp = usable
    .filter((m) => !m.free && m.supportsTools && (m.promptPerMTok ?? Infinity) <= 5)
    .sort((a, b) => estimatedStepCost(b) - estimatedStepCost(a));
  return pickDistinctFamilies([...curated, ...topUp]);
}
