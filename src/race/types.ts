/** Race domain types: configuration, the event log and derived state. No DOM. */
import type { LlmErrorKind, ReasoningEffort, Usage } from '../llm/types';

export interface RaceConfig {
  /** Canonical start title (resolved). */
  start: string;
  /** Canonical target title (resolved). */
  target: string;
  /** Lead text of the target, shown to every model. */
  targetSummary: string;
  /** Clicks per model, counting back moves and wasted invalid picks. */
  maxSteps: number;
  /** Links offered per page. Applied by the Wikipedia client; recorded here for replays. */
  linkCap: number;
  temperature: number;
  /** Visits to one page that mark a model as circling. */
  circlingThreshold: number;
  /**
   * Most times a racer may visit one page (by clicking links). At the cap the page is no longer
   * offered and `back` can't return to it. Optional so older replays load (they had no cap).
   */
  maxVisitsPerPage?: number;
  budgetUsd: number;
  budgetTokens: number;
  /** Pause between a racer's steps, in ms. */
  stepDelayMs: number;
  /** End the race for everyone as soon as one racer arrives. */
  stopOnFirstArrival: boolean;
  /**
   * Race in lockstep rounds: all racers take click N before any takes click N+1. Optional so
   * replays recorded before rounds existed still load (they ran free).
   */
  lockstep?: boolean;
  /** Reasoning effort sent to every model. Optional so older replays load. */
  reasoningEffort?: ReasoningEffort;
  /** Reply-token cap for every model (thinking included on most providers). */
  maxOutputTokens?: number;
  promptVersion: number;
}

export interface Racer {
  /** Unique id; the OpenRouter model id. */
  id: string;
  /** Display name. */
  label: string;
  /** Index into the neon palette. Assigned once so replays keep colours. */
  colorIndex: number;
}

interface Base {
  /** 0-based position in the log. */
  seq: number;
  /** Milliseconds since the race started. */
  t: number;
}

export type EndReason = 'all-done' | 'winner' | 'user-stopped';

export type RaceEvent = Base &
  (
    | { type: 'RaceStarted'; config: RaceConfig; racers: Racer[]; startedAtEpochMs: number }
    | { type: 'RacePaused' }
    | { type: 'RaceResumed' }
    | { type: 'RaceEnded'; reason: EndReason }
    | {
        type: 'StepTaken';
        racerId: string;
        /** Clicks used including this one. */
        step: number;
        from: string;
        /** Resolved title of the page arrived at (after redirects). */
        to: string;
        /** 1-based index in the list that was offered. */
        index: number;
        reason?: string;
        usage: Usage;
        latencyMs: number;
      }
    | {
        type: 'WentBack';
        racerId: string;
        step: number;
        from: string;
        to: string;
        reason?: string;
        usage: Usage;
        latencyMs: number;
      }
    | {
        type: 'InvalidChoice';
        racerId: string;
        /** Clicks used; only incremented when `wasted`. */
        step: number;
        at: string;
        problem: string;
        /** Truncated model output, for the log. Untrusted: render as text only. */
        raw: string;
        /** The engine will ask once more. */
        willRetry: boolean;
        /** This failure used up a click. */
        wasted: boolean;
        usage: Usage;
        latencyMs: number;
      }
    | { type: 'Revisited'; racerId: string; title: string; visits: number }
    | { type: 'Circling'; racerId: string; title: string; visits: number }
    | { type: 'Arrived'; racerId: string; steps: number; title: string }
    | { type: 'GaveUp'; racerId: string; steps: number }
    | { type: 'BudgetExceeded'; racerId: string; limit: 'usd' | 'tokens' }
    | { type: 'Stuck'; racerId: string; title: string }
    | {
        type: 'AgentFailed';
        racerId: string;
        kind: LlmErrorKind | 'wiki' | 'unexpected';
        message: string;
      }
  );

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as emitted by an agent. The store stamps `seq` and `t`. */
export type EventInput = DistributiveOmit<RaceEvent, 'seq' | 't'>;

export type RacerStatus =
  'racing' | 'arrived' | 'gave-up' | 'out-of-budget' | 'stuck' | 'failed' | 'stopped';

export interface RacerState {
  racer: Racer;
  status: RacerStatus;
  current: string;
  /** Back-navigation stack: start … current. `back` pops it. */
  stack: string[];
  /** Every page shown to the model in order, including returns after `back`. */
  trail: string[];
  steps: number;
  visits: Record<string, number>;
  /** Revisit events so far. */
  revisits: number;
  circling: boolean;
  invalidReplies: number;
  usage: Usage;
  lastReason?: string;
  lastLatencyMs?: number;
  /** Race time (ms) when this racer finished, if it did. */
  finishedAtMs?: number;
  /** Human-readable end explanation (failure message etc.). */
  note?: string;
}

export type RaceStatus = 'idle' | 'running' | 'paused' | 'finished' | 'stopped';

export interface RaceState {
  status: RaceStatus;
  config: RaceConfig | null;
  /** Racer ids in display order. */
  order: string[];
  racers: Record<string, RacerState>;
  /** First racer to arrive, by log order. */
  winnerId: string | null;
  eventCount: number;
  /** Race time of the latest event. */
  elapsedMs: number;
}
