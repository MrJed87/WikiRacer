import { describe, expect, it } from 'vitest';
import {
  failingFrom,
  flaky,
  looperDecider,
  scriptedDecider,
  shortestPathDecider,
  wandererDecider,
  seededRandom,
} from '../src/mock/behaviours';
import { LlmError } from '../src/llm/types';
import { RaceManager } from '../src/race/raceManager';
import { computeResults } from '../src/race/results';
import { replay } from '../src/race/store';
import { WikiError } from '../src/wiki/types';
import {
  authError,
  entrant,
  makeConfig,
  makeWiki,
  runRace,
  tickingStore,
  types,
} from './helpers/race';

const smart = () => shortestPathDecider(makeWiki().distancesTo('Target'));

describe('race outcomes', () => {
  it('arrived: follows the shortest path and wins', async () => {
    const { state, events } = await runRace({
      entrants: [entrant('smart', smart()), entrant('loop', looperDecider())],
    });
    const s = state.racers['smart'];
    expect(s?.status).toBe('arrived');
    expect(s?.steps).toBe(2);
    expect(s?.trail).toEqual(['Start', 'B', 'Target']);
    expect(state.winnerId).toBe('smart');
    expect(types(events, 'smart')).toEqual([
      'RaceStarted',
      'StepTaken',
      'StepTaken',
      'Arrived',
      'RaceEnded',
    ]);
    expect(state.status).toBe('finished');
    expect(events.at(-1)).toMatchObject({ type: 'RaceEnded', reason: 'all-done' });
  });

  it('circling: a looper revisits pages, is flagged, and keeps going until max steps', async () => {
    const { state, events } = await runRace({
      entrants: [entrant('loop', looperDecider()), entrant('smart', smart())],
      config: { maxSteps: 10 },
    });
    const l = state.racers['loop'];
    expect(l?.circling).toBe(true);
    expect(l?.revisits).toBeGreaterThanOrEqual(3);
    expect(l?.status).toBe('gave-up');
    expect(l?.steps).toBe(10);
    expect(events.filter((e) => e.type === 'Circling' && e.racerId === 'loop')).not.toHaveLength(0);
    expect(state.racers['smart']?.circling).toBe(false);
  });

  it('shows a neutral loop hint after a revisit', async () => {
    const loop = entrant('loop', looperDecider());
    await runRace({
      entrants: [loop, entrant('w', wandererDecider(seededRandom(1)))],
      config: { maxSteps: 4 },
    });
    const hints = loop.provider.requests.map((r) => r.hint).filter(Boolean);
    expect(hints.length).toBeGreaterThan(0);
    expect(hints[0]).toContain('already visited');
  });

  it('max steps: a racer that never reaches the target gives up', async () => {
    const { state } = await runRace({
      entrants: [entrant('w', wandererDecider(seededRandom(7))), entrant('l', looperDecider())],
      config: { maxSteps: 3, target: 'Target' },
      wiki: makeWiki({}, { Start: ['A'], A: ['Start'], Target: [] }),
    });
    expect(state.racers['w']?.status).toBe('gave-up');
    expect(state.racers['w']?.steps).toBe(3);
  });

  it('error isolation: a fatal 401 stops that racer only', async () => {
    const { state } = await runRace({
      entrants: [entrant('bad', failingFrom(smart(), 1, authError)), entrant('good', smart())],
    });
    expect(state.racers['bad']?.status).toBe('failed');
    expect(state.racers['bad']?.note).toContain('rejected');
    expect(state.racers['good']?.status).toBe('arrived');
    expect(state.winnerId).toBe('good');
  });

  it('reports non-LLM exceptions as failures without crashing the race', async () => {
    const boom = entrant('boom', () => {
      throw new Error('kaput');
    });
    const { state } = await runRace({ entrants: [boom, entrant('good', smart())] });
    expect(state.racers['boom']).toMatchObject({ status: 'failed', note: 'kaput' });
    expect(state.racers['good']?.status).toBe('arrived');
  });

  it('budget: stops a racer that spends past its cap', async () => {
    const { state, events } = await runRace({
      entrants: [
        entrant('spender', looperDecider(), { usdPerMTok: 1_000_000 }),
        entrant('smart', smart()),
      ],
      config: { budgetUsd: 0.5, maxSteps: 50 },
    });
    expect(state.racers['spender']?.status).toBe('out-of-budget');
    expect(events.some((e) => e.type === 'BudgetExceeded' && e.limit === 'usd')).toBe(true);
    const tokens = await runRace({
      entrants: [entrant('t', looperDecider()), entrant('u', looperDecider())],
      config: { budgetTokens: 1, maxSteps: 50 },
    });
    expect(tokens.events.some((e) => e.type === 'BudgetExceeded' && e.limit === 'tokens')).toBe(
      true,
    );
  });

  it('stuck: a dead-end start with no links ends that racer', async () => {
    const { state } = await runRace({
      entrants: [entrant('a', smart()), entrant('b', smart())],
      wiki: makeWiki({}, { Start: [], Target: [] }),
    });
    expect(state.racers['a']?.status).toBe('stuck');
  });

  it('arrives when a link redirects to the target', async () => {
    const wiki = makeWiki(
      { redirects: { 'Target Alias': 'Target' } },
      { Start: ['Target Alias'], Target: [] },
    );
    const { state } = await runRace({
      entrants: [
        entrant('a', scriptedDecider(['Target Alias'])),
        entrant('b', scriptedDecider(['Target Alias'])),
      ],
      wiki,
    });
    expect(state.racers['a']?.trail).toEqual(['Start', 'Target']);
    expect(state.racers['a']?.status).toBe('arrived');
  });

  it('fails a racer cleanly when the start page cannot load', async () => {
    const wiki = makeWiki({ failing: { Start: new WikiError('network', 'offline') } });
    const { state } = await runRace({
      entrants: [entrant('a', smart()), entrant('b', smart())],
      wiki,
    });
    expect(state.racers['a']).toMatchObject({ status: 'failed' });
    expect(state.racers['a']?.note).toContain('start page');
  });

  it('a link whose page cannot be opened wastes a click and the model stays put', async () => {
    const wiki = makeWiki({}, { Start: ['Ghost', 'B'], B: ['Target'], Target: [] });
    const decide = scriptedDecider(['Ghost', 'B', 'Target']);
    const a = entrant('a', decide);
    const { state, events } = await runRace({ entrants: [a, entrant('b', smart())], wiki });
    const waste = events.find((e) => e.type === 'InvalidChoice' && e.racerId === 'a');
    expect(waste).toMatchObject({ wasted: true, willRetry: false, step: 1 });
    expect(a.provider.requests[1]?.hint).toContain('could not be opened');
    expect(state.racers['a']?.status).toBe('arrived');
    expect(state.racers['a']?.steps).toBe(3);
  });
});

describe('invalid replies and back', () => {
  it('asks once more after an invalid reply, without spending a click, with a correction hint', async () => {
    const a = entrant('a', flaky(smart(), 2)); // call 1 is garbage
    const { state, events } = await runRace({ entrants: [a, entrant('b', smart())] });
    const invalid = events.find((e) => e.type === 'InvalidChoice' && e.racerId === 'a');
    expect(invalid).toMatchObject({ willRetry: true, wasted: false });
    expect(a.provider.requests[2]?.hint).toContain('not valid');
    expect(state.racers['a']?.steps).toBe(2);
    expect(state.racers['a']?.invalidReplies).toBe(1);
    expect(state.racers['a']?.status).toBe('arrived');
  });

  it('two invalid replies in a row waste a click and leave the racer in place', async () => {
    let n = 0;
    const a = entrant('a', (req, call) => (call < 2 ? { garbage: 'nope' } : smart()(req, n++)));
    const { state, events } = await runRace({ entrants: [a, entrant('b', smart())] });
    const wasted = events.find((e) => e.type === 'InvalidChoice' && e.racerId === 'a' && e.wasted);
    expect(wasted).toMatchObject({ step: 1, at: 'Start' });
    expect(state.racers['a']?.steps).toBe(3);
    expect(state.racers['a']?.trail).toEqual(['Start', 'B', 'Target']);
  });

  it('back returns to the previous page, counts a click and is not a revisit', async () => {
    const script = [
      { link: 'A' },
      { back: true as const },
      { link: 'B' },
      { link: 'Target' },
    ] as const;
    const a = entrant('a', (_req, call) => script[call] ?? { back: true });
    const { state, events } = await runRace({ entrants: [a, entrant('b', smart())] });
    const s = state.racers['a'];
    expect(s?.trail).toEqual(['Start', 'A', 'Start', 'B', 'Target']);
    expect(s?.steps).toBe(4);
    expect(s?.visits['Start']).toBe(1);
    expect(s?.revisits).toBe(0);
    expect(events.some((e) => e.type === 'WentBack' && e.racerId === 'a' && e.to === 'Start')).toBe(
      true,
    );
  });

  it('rejects back on the first page as an invalid reply', async () => {
    const a = entrant('a', (req, call) => (call === 0 ? { back: true } : smart()(req, call)));
    const { events } = await runRace({ entrants: [a, entrant('b', smart())] });
    expect(events.find((e) => e.type === 'InvalidChoice' && e.racerId === 'a')?.type).toBe(
      'InvalidChoice',
    );
    expect(a.provider.requests[0]?.canGoBack).toBe(false);
  });
});

describe('fairness and reproducibility', () => {
  it('gives every model an identical request apart from its id', async () => {
    const a = entrant('model/a', smart());
    const b = entrant('model/b', wandererDecider(seededRandom(3)));
    await runRace({ entrants: [a, b], config: { temperature: 0.4, maxSteps: 7 } });
    const strip = (r: (typeof a.provider.requests)[number]) => ({
      ...r,
      model: '',
      signal: undefined,
    });
    expect(strip(a.provider.requests[0] as never)).toEqual(strip(b.provider.requests[0] as never));
    for (const r of [...a.provider.requests, ...b.provider.requests]) {
      expect(r).toMatchObject({
        target: 'Target',
        temperature: 0.4,
        maxSteps: 7,
        targetSummary: 'The goal.',
      });
    }
  });

  it('replaying the log reproduces the final state, and equal inputs give an equal log', async () => {
    const make = () =>
      runRace({
        entrants: [
          entrant('smart', smart()),
          entrant('loop', looperDecider()),
          entrant('w', wandererDecider(seededRandom(5))),
        ],
      });
    const one = await make();
    expect(replay(JSON.parse(JSON.stringify(one.events)))).toEqual(one.state);
    const two = await make();
    const sig = (events: typeof one.events) =>
      events.map((e) => ('racerId' in e ? `${e.racerId}:${e.type}` : e.type)).sort();
    expect(sig(two.events)).toEqual(sig(one.events));
    expect(computeResults(one.state).fewestClicksId).toBe('smart');
  });
});

describe('RaceManager control', () => {
  const manager = (entrants: ReturnType<typeof entrant>[], cfg = {}) =>
    new RaceManager({
      entrants,
      wiki: makeWiki(),
      config: makeConfig(cfg),
      store: tickingStore(),
      sleep: async () => {},
    });

  it('validates the number of racers and uniqueness', () => {
    expect(() => manager([entrant('a', smart())]).start()).toThrow(/needs 2 to 6/);
    expect(() => manager([entrant('a', smart()), entrant('a', smart())]).start()).toThrow(
      /different model/,
    );
    const seven = Array.from({ length: 7 }, (_, i) => entrant(`m${i}`, smart()));
    expect(() => manager(seven).start()).toThrow(/needs 2 to 6/);
  });

  it('start is idempotent', async () => {
    const m = manager([entrant('a', smart()), entrant('b', smart())]);
    const p = m.start();
    expect(m.start()).toBe(p);
    await p;
    expect(m.store.events.filter((e) => e.type === 'RaceStarted')).toHaveLength(1);
  });

  it('stopOnFirstArrival ends the race for everyone when someone wins', async () => {
    const slow = entrant('slow', looperDecider(), { latencyMs: 5_000 });
    const fast = entrant('fast', smart());
    const m = manager([slow, fast], { stopOnFirstArrival: true });
    await m.start();
    const { state, events } = m.store;
    expect(events.at(-1)).toMatchObject({ type: 'RaceEnded', reason: 'winner' });
    expect(state.status).toBe('finished');
    expect(state.racers['fast']?.status).toBe('arrived');
    expect(state.racers['slow']?.status).toBe('stopped');
  });

  it('stop() cancels in-flight work and ends with user-stopped', async () => {
    const m = manager([
      entrant('a', smart(), { latencyMs: 60_000 }),
      entrant('b', smart(), { latencyMs: 60_000 }),
    ]);
    const run = m.start();
    await new Promise((r) => setTimeout(r, 10));
    m.stop();
    await run;
    expect(m.store.state.status).toBe('stopped');
    expect(m.store.state.racers['a']?.status).toBe('stopped');
    const count = m.store.events.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(m.store.events).toHaveLength(count);
  });

  it('pause holds every racer and resume lets them finish', async () => {
    const m = manager([entrant('a', smart()), entrant('b', smart())]);
    const run = m.start();
    m.pause();
    await new Promise((r) => setTimeout(r, 20));
    expect(m.store.state.status).toBe('paused');
    expect(m.store.events.some((e) => e.type === 'StepTaken')).toBe(false);
    m.resume();
    await run;
    expect(m.store.state.racers['a']?.status).toBe('arrived');
    expect(m.store.events.some((e) => e.type === 'RacePaused')).toBe(true);
    expect(m.store.events.some((e) => e.type === 'RaceResumed')).toBe(true);
  });

  it('stop while paused does not hang', async () => {
    const m = manager([entrant('a', smart()), entrant('b', smart())]);
    const run = m.start();
    m.pause();
    m.stop();
    await run;
    expect(m.store.state.status).toBe('stopped');
  });

  it('ignores stop/pause/resume before start or after the end', async () => {
    const m = manager([entrant('a', smart()), entrant('b', smart())]);
    m.pause();
    m.stop();
    expect(m.store.events).toHaveLength(0);
    await m.start();
    const n = m.store.events.length;
    m.pause();
    m.resume();
    m.stop();
    expect(m.store.events).toHaveLength(n);
  });

  it('a non-fatal LLM failure also ends only that racer', async () => {
    const m = manager([
      entrant('a', failingFrom(smart(), 0, new LlmError('server', 'upstream exploded'))),
      entrant('b', smart()),
    ]);
    await m.start();
    expect(m.store.state.racers['a']).toMatchObject({
      status: 'failed',
      note: 'upstream exploded',
    });
    expect(m.store.state.racers['b']?.status).toBe('arrived');
  });
});

describe('buildRaceConfig resolution', () => {
  it('resolves redirects and canonicalises both start and target titles', async () => {
    const wiki = makeWiki(
      { redirects: { 'Start alias': 'United States', 'Goal article': 'Final Target' } },
      { 'United States': ['A'], 'Final Target': [] },
    );
    const { buildRaceConfig } = await import('../src/race/setup');
    const config = await buildRaceConfig(wiki, {
      start: 'start_alias',
      target: 'goal_article',
    });
    expect(config.start).toBe('United States');
    expect(config.target).toBe('Final Target');
  });
});
