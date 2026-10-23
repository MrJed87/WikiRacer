/**
 * Append-only event log plus a pure reducer. Anything the UI shows is derived from the log, which is
 * what makes replay possible: feed a saved log through `replay` and you get the same state.
 * No DOM.
 */
import { addUsage, ZERO_USAGE } from '../llm/types';
import type { EventInput, RaceEvent, RaceState, RacerState } from './types';

export function initialRaceState(): RaceState {
  return {
    status: 'idle',
    config: null,
    order: [],
    racers: {},
    winnerId: null,
    eventCount: 0,
    elapsedMs: 0,
  };
}

function updateRacer(
  state: RaceState,
  id: string,
  patch: (r: RacerState) => RacerState,
): RaceState {
  const racer = state.racers[id];
  if (!racer) return state; // Events for unknown racers are ignored rather than trusted.
  return { ...state, racers: { ...state.racers, [id]: patch(racer) } };
}

export function reduce(prev: RaceState, event: RaceEvent): RaceState {
  const state: RaceState = { ...prev, eventCount: prev.eventCount + 1, elapsedMs: event.t };
  switch (event.type) {
    case 'RaceStarted': {
      const racers: Record<string, RacerState> = {};
      for (const racer of event.racers) {
        racers[racer.id] = {
          racer,
          status: 'racing',
          current: event.config.start,
          stack: [event.config.start],
          trail: [event.config.start],
          steps: 0,
          visits: { [event.config.start]: 1 },
          revisits: 0,
          circling: false,
          invalidReplies: 0,
          usage: ZERO_USAGE,
        };
      }
      return {
        ...state,
        status: 'running',
        config: event.config,
        order: event.racers.map((r) => r.id),
        racers,
        winnerId: null,
      };
    }
    case 'RacePaused':
      return state.status === 'running' ? { ...state, status: 'paused' } : state;
    case 'RaceResumed':
      return state.status === 'paused' ? { ...state, status: 'running' } : state;
    case 'RaceEnded': {
      const racers: Record<string, RacerState> = {};
      for (const [id, r] of Object.entries(state.racers)) {
        racers[id] = r.status === 'racing' ? { ...r, status: 'stopped', finishedAtMs: event.t } : r;
      }
      return { ...state, racers, status: event.reason === 'user-stopped' ? 'stopped' : 'finished' };
    }
    case 'StepTaken':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        steps: event.step,
        current: event.to,
        stack: [...r.stack, event.to],
        trail: [...r.trail, event.to],
        visits: { ...r.visits, [event.to]: (r.visits[event.to] ?? 0) + 1 },
        usage: addUsage(r.usage, event.usage),
        lastLatencyMs: event.latencyMs,
        ...(event.reason !== undefined ? { lastReason: event.reason } : {}),
      }));
    case 'WentBack':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        steps: event.step,
        current: event.to,
        // Never pop the start page.
        stack: r.stack.length > 1 ? r.stack.slice(0, -1) : r.stack,
        trail: [...r.trail, event.to],
        usage: addUsage(r.usage, event.usage),
        lastLatencyMs: event.latencyMs,
        ...(event.reason !== undefined ? { lastReason: event.reason } : {}),
      }));
    case 'InvalidChoice':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        invalidReplies: r.invalidReplies + 1,
        steps: event.wasted ? event.step : r.steps,
        usage: addUsage(r.usage, event.usage),
        lastLatencyMs: event.latencyMs,
      }));
    case 'Revisited':
      return updateRacer(state, event.racerId, (r) => ({ ...r, revisits: r.revisits + 1 }));
    case 'Circling':
      return updateRacer(state, event.racerId, (r) => ({ ...r, circling: true }));
    case 'Arrived': {
      const next = updateRacer(state, event.racerId, (r) => ({
        ...r,
        status: 'arrived',
        steps: event.steps,
        finishedAtMs: event.t,
      }));
      return { ...next, winnerId: next.winnerId ?? event.racerId };
    }
    case 'GaveUp':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        status: 'gave-up',
        finishedAtMs: event.t,
        note: `Ran out of clicks after ${event.steps}.`,
      }));
    case 'BudgetExceeded':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        status: 'out-of-budget',
        finishedAtMs: event.t,
        note: event.limit === 'usd' ? 'Hit the spending cap.' : 'Hit the token cap.',
      }));
    case 'Stuck':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        status: 'stuck',
        finishedAtMs: event.t,
        note: `Dead end at “${event.title}”.`,
      }));
    case 'AgentFailed':
      return updateRacer(state, event.racerId, (r) => ({
        ...r,
        status: 'failed',
        finishedAtMs: event.t,
        note: event.message,
      }));
  }
}

/** Rebuild state from a saved log. Used by replay and by tests. */
export function replay(events: readonly RaceEvent[]): RaceState {
  return events.reduce(reduce, initialRaceState());
}

export type StoreListener = (event: RaceEvent, state: RaceState) => void;

export interface RaceStoreOptions {
  /** Injectable clock (epoch ms) so tests are deterministic. */
  now?: () => number;
}

export class RaceStore {
  private readonly log: RaceEvent[] = [];
  private current: RaceState = initialRaceState();
  private readonly listeners = new Set<StoreListener>();
  private readonly now: () => number;
  private startedAt: number | null = null;

  constructor(opts: RaceStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  get state(): RaceState {
    return this.current;
  }

  /** A copy, so callers (e.g. export) can't mutate the log. */
  get events(): readonly RaceEvent[] {
    return [...this.log];
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stamp `seq` and `t`, append, reduce and notify. */
  emit(input: EventInput): RaceEvent {
    const nowMs = this.now();
    if (input.type === 'RaceStarted') this.startedAt = nowMs;
    const t = this.startedAt === null ? 0 : Math.max(0, nowMs - this.startedAt);
    const event = { ...input, seq: this.log.length, t } as RaceEvent;
    this.log.push(event);
    this.current = reduce(this.current, event);
    for (const l of [...this.listeners]) l(event, this.current);
    return event;
  }

  /** Load a saved log (replay). Listeners are notified per event. */
  static fromEvents(events: readonly RaceEvent[]): RaceStore {
    const store = new RaceStore();
    for (const e of events) {
      store.log.push(e);
      store.current = reduce(store.current, e);
    }
    return store;
  }
}
