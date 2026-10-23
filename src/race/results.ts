/** Derived race results: who won, in two senses. No DOM. */
import type { RaceState, RacerStatus } from './types';

export interface Standing {
  racerId: string;
  /** 1-based by (clicks, then finish time) among racers that arrived; null for those who didn't. */
  rank: number | null;
  status: RacerStatus;
  steps: number;
  finishedAtMs: number | null;
  costUsd: number;
}

export interface Results {
  standings: Standing[];
  /** First to arrive in wall-clock terms (the headline winner). */
  fastestId: string | null;
  /** Arrived in the fewest clicks; ties go to whoever got there first. */
  fewestClicksId: string | null;
}

export function computeResults(state: RaceState): Results {
  const rows: Standing[] = state.order.flatMap((id) => {
    const r = state.racers[id];
    if (!r) return [];
    return [
      {
        racerId: id,
        rank: null,
        status: r.status,
        steps: r.steps,
        finishedAtMs: r.finishedAtMs ?? null,
        costUsd: r.usage.costUsd,
      },
    ];
  });

  const arrived = rows
    .filter((r) => r.status === 'arrived')
    .sort(
      (a, b) => a.steps - b.steps || (a.finishedAtMs ?? Infinity) - (b.finishedAtMs ?? Infinity),
    );
  arrived.forEach((r, i) => (r.rank = i + 1));

  const others = rows
    .filter((r) => r.status !== 'arrived')
    .sort((a, b) => b.steps - a.steps || a.racerId.localeCompare(b.racerId));

  return {
    standings: [...arrived, ...others],
    fastestId: state.winnerId,
    fewestClicksId: arrived[0]?.racerId ?? null,
  };
}

const OUTCOME_LABELS: Partial<Record<RacerStatus, [string, string]>> = {
  'gave-up': ['ran out of clicks', 'ran out of clicks'],
  'out-of-budget': ['went over budget', 'went over budget'],
  stuck: ['got stuck on a dead end', 'got stuck on dead ends'],
  failed: ['hit an error', 'hit errors'],
  stopped: ['was stopped', 'were stopped'],
  racing: ['was still racing', 'were still racing'],
};

/**
 * One line explaining why nobody arrived, from what actually happened. If every racer failed with
 * the same error, that error is the explanation (e.g. a start page that doesn't exist).
 */
export function noArrivalSummary(state: RaceState): string {
  const racers = state.order.flatMap((id) => (state.racers[id] ? [state.racers[id]] : []));
  if (racers.length === 0) return 'No racers took part.';
  const notes = new Set(racers.map((r) => r.note ?? ''));
  if (racers.every((r) => r.status === 'failed') && notes.size === 1 && racers[0]?.note) {
    return `Every racer stopped with the same error: ${racers[0].note}`;
  }
  const counts = new Map<RacerStatus, number>();
  for (const r of racers) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const parts = [...counts].flatMap(([status, n]) => {
    const label = OUTCOME_LABELS[status];
    return label ? [`${n} ${n === 1 ? label[0] : label[1]}`] : [];
  });
  return `Nobody reached the target: ${parts.join(', ')}.`;
}
