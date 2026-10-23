import { describe, expect, it } from 'vitest';
import { ZERO_USAGE } from '../src/llm/types';
import { LoopTracker, loopHint } from '../src/race/loopDetector';
import { computeResults } from '../src/race/results';
import { RaceStore, initialRaceState, reduce, replay } from '../src/race/store';
import type { Racer } from '../src/race/types';
import { makeConfig, tickingStore } from './helpers/race';

const racers: Racer[] = [
  { id: 'a', label: 'A', colorIndex: 0 },
  { id: 'b', label: 'B', colorIndex: 1 },
];

const step = (racerId: string, n: number, from: string, to: string) =>
  ({
    type: 'StepTaken',
    racerId,
    step: n,
    from,
    to,
    index: 1,
    usage: { ...ZERO_USAGE, totalTokens: 10, costUsd: 0.01 },
    latencyMs: 5,
  }) as const;

describe('RaceStore / reducer', () => {
  it('stamps seq and t, derives state and notifies subscribers', () => {
    const store = tickingStore();
    const seen: string[] = [];
    const off = store.subscribe((e, s) => seen.push(`${e.seq}:${e.type}:${s.status}`));
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit(step('a', 1, 'Start', 'A'));
    off();
    store.emit(step('a', 2, 'A', 'D'));
    expect(seen).toEqual(['0:RaceStarted:running', '1:StepTaken:running']);
    const events = store.events;
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events[0]?.t).toBe(0);
    expect(events[2]?.t).toBe(20);
    const a = store.state.racers['a'];
    expect(a?.current).toBe('D');
    expect(a?.stack).toEqual(['Start', 'A', 'D']);
    expect(a?.steps).toBe(2);
    expect(a?.usage.totalTokens).toBe(20);
    expect(a?.visits).toEqual({ Start: 1, A: 1, D: 1 });
  });

  it('pops the stack on back, never below the start, and keeps the trail', () => {
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit(step('a', 1, 'Start', 'A'));
    store.emit({
      type: 'WentBack',
      racerId: 'a',
      step: 2,
      from: 'A',
      to: 'Start',
      usage: ZERO_USAGE,
      latencyMs: 1,
    });
    store.emit({
      type: 'WentBack',
      racerId: 'a',
      step: 3,
      from: 'Start',
      to: 'Start',
      usage: ZERO_USAGE,
      latencyMs: 1,
    });
    const a = store.state.racers['a'];
    expect(a?.stack).toEqual(['Start']);
    expect(a?.trail).toEqual(['Start', 'A', 'Start', 'Start']);
    expect(a?.visits['Start']).toBe(1);
  });

  it('exposes a copy of the log and ignores events for unknown racers', () => {
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit(step('ghost', 1, 'Start', 'A'));
    expect(Object.keys(store.state.racers)).toEqual(['a', 'b']);
    (store.events as unknown[]).length = 0;
    expect(store.events).toHaveLength(2);
  });

  it('records the first arrival as winner and marks unfinished racers stopped on end', () => {
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit({ type: 'Arrived', racerId: 'b', steps: 3, title: 'Target' });
    store.emit({ type: 'Arrived', racerId: 'a', steps: 2, title: 'Target' });
    expect(store.state.winnerId).toBe('b');
    const s2 = tickingStore();
    s2.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    s2.emit({ type: 'RaceEnded', reason: 'user-stopped' });
    expect(s2.state.status).toBe('stopped');
    expect(s2.state.racers['a']?.status).toBe('stopped');
  });

  it('only pauses a running race and only resumes a paused one', () => {
    let s = initialRaceState();
    s = reduce(s, { seq: 0, t: 0, type: 'RacePaused' });
    expect(s.status).toBe('idle');
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit({ type: 'RacePaused' });
    expect(store.state.status).toBe('paused');
    store.emit({ type: 'RaceResumed' });
    expect(store.state.status).toBe('running');
  });

  it('replays a saved log to the same state (and loads via fromEvents)', () => {
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    store.emit(step('a', 1, 'Start', 'A'));
    store.emit({ type: 'Circling', racerId: 'a', title: 'A', visits: 3 });
    store.emit({ type: 'Arrived', racerId: 'a', steps: 1, title: 'Target' });
    const copy = JSON.parse(JSON.stringify(store.events)) as typeof store.events;
    expect(replay(copy)).toEqual(store.state);
    expect(RaceStore.fromEvents(copy).state).toEqual(store.state);
  });
});

describe('LoopTracker', () => {
  it('counts visits, flags revisits and fires circling exactly at the threshold', () => {
    const t = new LoopTracker(3);
    t.seed('Start');
    expect(t.visit('A')).toEqual({ visits: 1, revisited: false, startedCircling: false });
    expect(t.visit('Start')).toEqual({ visits: 2, revisited: true, startedCircling: false });
    expect(t.visit('Start')).toEqual({ visits: 3, revisited: true, startedCircling: true });
    expect(t.visit('Start')).toEqual({ visits: 4, revisited: true, startedCircling: false });
    expect(t.visitsTo('Start')).toBe(4);
    expect(t.visitsTo('Nowhere')).toBe(0);
  });

  it('gives a neutral hint only for repeat visits', () => {
    expect(loopHint('A', 1)).toBeUndefined();
    expect(loopHint('A', 2)).toContain('once before');
    expect(loopHint('A', 4)).toContain('3 times');
  });
});

describe('computeResults', () => {
  it('separates fastest to arrive from fewest clicks and ranks only arrivals', () => {
    const store = tickingStore();
    const three: Racer[] = [...racers, { id: 'c', label: 'C', colorIndex: 2 }];
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers: three, startedAtEpochMs: 0 });
    store.emit({ type: 'Arrived', racerId: 'a', steps: 5, title: 'Target' });
    store.emit({ type: 'Arrived', racerId: 'b', steps: 2, title: 'Target' });
    store.emit({ type: 'GaveUp', racerId: 'c', steps: 10 });
    const r = computeResults(store.state);
    expect(r.fastestId).toBe('a');
    expect(r.fewestClicksId).toBe('b');
    expect(r.standings.map((s) => [s.racerId, s.rank])).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', null],
    ]);
  });

  it('has no winner when nobody arrives', () => {
    const store = tickingStore();
    store.emit({ type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 });
    const r = computeResults(store.state);
    expect(r.fastestId).toBeNull();
    expect(r.fewestClicksId).toBeNull();
  });
});
