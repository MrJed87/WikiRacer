/**
 * Pure Replay Controller.
 *
 * Recreates graph and race state step-by-step from an exported event log.
 * Provides seek, step, play, pause, and speed adjustments. No DOM.
 */
import { buildGraph, createGraph, type GraphModel } from '../graph/graphModel';
import { reduce, initialRaceState } from './store';
import type { RaceConfig, RaceEvent, Racer, RaceState } from './types';

export interface ReplayData {
  app: string;
  version: number;
  exportedAt?: string;
  config: RaceConfig;
  racers: Racer[];
  events: RaceEvent[];
}

export function validateReplayData(raw: unknown): ReplayData {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid replay file: not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.events) || obj.events.length === 0) {
    throw new Error('Invalid replay file: missing or empty events array.');
  }
  if (!Array.isArray(obj.racers) || obj.racers.length === 0) {
    throw new Error('Invalid replay file: missing racers array.');
  }
  if (!obj.config || typeof obj.config !== 'object') {
    throw new Error('Invalid replay file: missing race config.');
  }
  return obj as unknown as ReplayData;
}

export interface ReplaySubscriber {
  (params: {
    index: number;
    total: number;
    event: RaceEvent | null;
    state: RaceState;
    graph: GraphModel;
    isPlaying: boolean;
  }): void;
}

export class ReplayController {
  readonly config: RaceConfig;
  readonly racers: readonly Racer[];
  readonly events: readonly RaceEvent[];

  private currentIndex = 0;
  private isPlaying = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private stepDelayMs = 400;
  private readonly subscribers = new Set<ReplaySubscriber>();

  // Cached state and graph snapshots for fast seeking
  private cachedStates: RaceState[] = [];
  private cachedGraphs: GraphModel[] = [];

  constructor(data: ReplayData) {
    this.config = data.config;
    this.racers = data.racers;
    this.events = data.events;

    this.precomputeSnapshots();
  }

  private precomputeSnapshots(): void {
    let currentState: RaceState = initialRaceState();
    this.cachedStates.push(currentState);
    this.cachedGraphs.push(createGraph());

    for (let i = 0; i < this.events.length; i++) {
      const ev = this.events[i]!;
      currentState = reduce(currentState, ev);
      this.cachedStates.push(currentState);
      this.cachedGraphs.push(buildGraph(this.events.slice(0, i + 1)));
    }
  }

  get totalEvents(): number {
    return this.events.length;
  }

  get index(): number {
    return this.currentIndex;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get delayMs(): number {
    return this.stepDelayMs;
  }

  setDelayMs(ms: number): void {
    this.stepDelayMs = Math.max(50, Math.min(2000, ms));
    if (this.isPlaying) {
      this.stopTimer();
      this.startTimer();
    }
  }

  subscribe(sub: ReplaySubscriber): () => void {
    this.subscribers.add(sub);
    this.notify();
    return () => {
      this.subscribers.delete(sub);
    };
  }

  private notify(): void {
    const event = this.currentIndex > 0 ? (this.events[this.currentIndex - 1] ?? null) : null;
    const state = this.cachedStates[this.currentIndex] ?? initialRaceState();
    const graph = this.cachedGraphs[this.currentIndex] ?? createGraph();

    for (const sub of this.subscribers) {
      sub({
        index: this.currentIndex,
        total: this.events.length,
        event,
        state,
        graph,
        isPlaying: this.isPlaying,
      });
    }
  }

  seek(index: number): void {
    const clamped = Math.max(0, Math.min(this.events.length, index));
    this.currentIndex = clamped;
    this.notify();
  }

  stepForward(): void {
    if (this.currentIndex < this.events.length) {
      this.currentIndex++;
      this.notify();
    } else {
      this.pause();
    }
  }

  stepBackward(): void {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.notify();
    }
  }

  play(): void {
    if (this.isPlaying) return;
    if (this.currentIndex >= this.events.length) {
      this.currentIndex = 0;
    }
    this.isPlaying = true;
    this.startTimer();
    this.notify();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.stopTimer();
    this.notify();
  }

  toggle(): void {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  private startTimer(): void {
    this.stopTimer();
    this.timerId = setInterval(() => {
      if (this.currentIndex < this.events.length) {
        this.stepForward();
      } else {
        this.pause();
      }
    }, this.stepDelayMs);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  destroy(): void {
    this.pause();
    this.subscribers.clear();
  }
}
