/**
 * Runs all racers concurrently and owns pause / resume / stop. Agents and the UI never talk to each
 * other directly: everything flows through the `RaceStore` event log. No DOM.
 */
import { RACE_DEFAULTS } from '../config';
import type { LlmProvider } from '../llm/types';
import type { WikiSource } from '../wiki/types';
import { runAgent } from './agent';
import { RoundBarrier } from './rounds';
import { RaceStore } from './store';
import type { EndReason, RaceConfig, Racer } from './types';

export interface Entrant {
  racer: Racer;
  provider: LlmProvider;
}

export interface RaceManagerOptions {
  entrants: readonly Entrant[];
  wiki: WikiSource;
  config: RaceConfig;
  store?: RaceStore;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RaceManager {
  readonly store: RaceStore;
  private readonly abort = new AbortController();
  private readonly waiters: Array<() => void> = [];
  private paused = false;
  private ended = false;
  private running: Promise<void> | null = null;
  private rounds: RoundBarrier | null = null;

  constructor(private readonly opts: RaceManagerOptions) {
    this.store = opts.store ?? new RaceStore();
  }

  /** Starts the race. Resolves when it has ended. Calling again returns the same promise. */
  start(): Promise<void> {
    if (this.running) return this.running;
    const { entrants, config } = this.opts;
    if (entrants.length < RACE_DEFAULTS.minModels || entrants.length > RACE_DEFAULTS.maxModels) {
      throw new Error(
        `A race needs ${RACE_DEFAULTS.minModels} to ${RACE_DEFAULTS.maxModels} models.`,
      );
    }
    if (new Set(entrants.map((e) => e.racer.id)).size !== entrants.length) {
      throw new Error('Each racer must be a different model.');
    }

    this.store.emit({
      type: 'RaceStarted',
      config,
      racers: entrants.map((e) => e.racer),
      startedAtEpochMs: Date.now(),
    });

    if (config.stopOnFirstArrival) {
      const unsubscribe = this.store.subscribe((event) => {
        if (event.type === 'Arrived') {
          unsubscribe();
          // Deferred so listeners finish seeing `Arrived` before `RaceEnded` is appended.
          queueMicrotask(() => this.end('winner'));
        }
      });
    }

    const rounds = config.lockstep ? new RoundBarrier(entrants.map((e) => e.racer.id)) : null;
    this.rounds = rounds;

    this.running = Promise.all(
      entrants.map((e) =>
        runAgent({
          racer: e.racer,
          provider: e.provider,
          wiki: this.opts.wiki,
          config,
          emit: (event) => {
            // After the race has ended nothing else may enter the log.
            if (!this.ended) this.store.emit(event);
          },
          signal: this.abort.signal,
          gate: this.gate,
          ...(rounds ? { roundGate: () => rounds.wait(e.racer.id) } : {}),
          ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
        }).finally(() => rounds?.leave(e.racer.id)),
      ),
    ).then(() => this.end('all-done'));
    return this.running;
  }

  private readonly gate = (): Promise<void> =>
    this.paused ? new Promise<void>((resolve) => this.waiters.push(resolve)) : Promise.resolve();

  pause(): void {
    if (this.ended || this.paused || !this.running) return;
    this.paused = true;
    this.store.emit({ type: 'RacePaused' });
  }

  resume(): void {
    if (this.ended || !this.paused) return;
    this.paused = false;
    this.store.emit({ type: 'RaceResumed' });
    this.releaseWaiters();
  }

  /** Cancels in-flight requests and ends the race. */
  stop(): void {
    this.end('user-stopped');
  }

  private end(reason: EndReason): void {
    if (this.ended || !this.running) return;
    this.ended = true;
    this.abort.abort();
    this.releaseWaiters();
    this.rounds?.releaseAll();
    this.store.emit({ type: 'RaceEnded', reason });
  }

  private releaseWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
