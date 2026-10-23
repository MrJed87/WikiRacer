/**
 * What models have actually cost this viewer, learned from finished races. OpenRouter's catalogue
 * shows the cheapest provider's price, but an account limited to certain providers can pay more,
 * so real per-click costs make better "cheap" picks. No DOM; storage lives in ui/storage.ts.
 */
import type { RaceEvent } from './types';

export interface CostRecord {
  /** Model calls that returned usage (clicks, back moves and invalid replies). */
  calls: number;
  costUsd: number;
  races: number;
}

export type CostHistory = Record<string, CostRecord>;

/** Calls needed before an observed average is trusted over the catalogue estimate. */
export const MIN_OBSERVED_CALLS = 5;

/** Per-racer calls and spend in one race's event log. */
export function costSamples(
  events: readonly RaceEvent[],
): Map<string, { calls: number; costUsd: number }> {
  const out = new Map<string, { calls: number; costUsd: number }>();
  for (const e of events) {
    if (e.type !== 'StepTaken' && e.type !== 'WentBack' && e.type !== 'InvalidChoice') continue;
    const s = out.get(e.racerId) ?? { calls: 0, costUsd: 0 };
    s.calls += 1;
    s.costUsd += Number.isFinite(e.usage.costUsd) ? e.usage.costUsd : 0;
    out.set(e.racerId, s);
  }
  return out;
}

/** Adds one race's samples to the history (returns a new object). */
export function mergeCostHistory(history: CostHistory, events: readonly RaceEvent[]): CostHistory {
  const next: CostHistory = { ...history };
  for (const [id, s] of costSamples(events)) {
    if (s.calls === 0) continue;
    const prev = next[id] ?? { calls: 0, costUsd: 0, races: 0 };
    next[id] = {
      calls: prev.calls + s.calls,
      costUsd: prev.costUsd + s.costUsd,
      races: prev.races + 1,
    };
  }
  return next;
}

/** Average real cost per model call, once there's enough data to trust it. */
export function observedCostPerCall(
  history: CostHistory,
  id: string,
  minCalls = MIN_OBSERVED_CALLS,
): number | undefined {
  const r = history[id];
  return r && r.calls >= minCalls ? r.costUsd / r.calls : undefined;
}

/** Keeps only well-formed records, so a corrupted or old stored value can't break the app. */
export function sanitiseCostHistory(raw: unknown): CostHistory {
  const out: CostHistory = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    const calls = r['calls'];
    const costUsd = r['costUsd'];
    const races = r['races'];
    if (
      typeof calls === 'number' &&
      calls >= 0 &&
      typeof costUsd === 'number' &&
      costUsd >= 0 &&
      typeof races === 'number' &&
      races >= 0
    ) {
      out[id] = { calls, costUsd, races };
    }
  }
  return out;
}
