/**
 * Lockstep rounds: every racer still in the race takes click N before anyone takes click N+1.
 * Within a round the racers run at the same time; nobody waits for anyone's whole run. No DOM.
 */
export class RoundBarrier {
  private readonly active: Set<string>;
  private readonly waiting = new Map<string, () => void>();
  private released = false;
  /** Completed rounds, for tests and diagnostics. */
  round = 0;

  constructor(racerIds: Iterable<string>) {
    this.active = new Set(racerIds);
  }

  /** Resolves once every active racer has reached this point for the current round. */
  wait(racerId: string): Promise<void> {
    if (this.released || !this.active.has(racerId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.waiting.set(racerId, resolve);
      this.check();
    });
  }

  /** A racer has finished (arrived, failed, gave up…), so the others stop waiting for it. */
  leave(racerId: string): void {
    this.active.delete(racerId);
    this.waiting.get(racerId)?.();
    this.waiting.delete(racerId);
    this.check();
  }

  /** Lets everyone through for good (race stopped). */
  releaseAll(): void {
    this.released = true;
    for (const resolve of this.waiting.values()) resolve();
    this.waiting.clear();
  }

  private check(): void {
    if (this.waiting.size === 0) return;
    for (const id of this.active) if (!this.waiting.has(id)) return;
    this.round++;
    const go = [...this.waiting.values()];
    this.waiting.clear();
    for (const resolve of go) resolve();
  }
}
