/** Per-racer visit counting, loop notices and the neutral hint shown to the model. No DOM. */

export interface VisitOutcome {
  visits: number;
  /** Seen before (visits >= 2). */
  revisited: boolean;
  /** This visit is the one that reached the circling threshold. */
  startedCircling: boolean;
}

export class LoopTracker {
  private readonly counts = new Map<string, number>();

  constructor(private readonly threshold: number) {}

  /** Count the start page without any revisit semantics. */
  seed(title: string): void {
    this.counts.set(title, 1);
  }

  visit(title: string): VisitOutcome {
    const visits = (this.counts.get(title) ?? 0) + 1;
    this.counts.set(title, visits);
    return { visits, revisited: visits >= 2, startedCircling: visits === this.threshold };
  }

  visitsTo(title: string): number {
    return this.counts.get(title) ?? 0;
  }
}

/**
 * Neutral nudge for the prompt. It states a fact and never prescribes a link, and it is the same
 * wording for every model (fairness).
 */
export function loopHint(title: string, visits: number, maxVisits?: number): string | undefined {
  if (visits < 2) return undefined;
  if (maxVisits !== undefined && maxVisits > 0 && visits >= maxVisits) {
    return `You have now visited "${title}" ${visits} times, the maximum allowed, so you cannot return to it after leaving.`;
  }
  if (visits === 2) return `You have already visited "${title}" once before.`;
  return `You have already visited "${title}" ${visits - 1} times before. You may be going in circles.`;
}
