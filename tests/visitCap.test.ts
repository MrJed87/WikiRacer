/** Bare-number replies and the per-page visit cap. */
import { describe, expect, it } from 'vitest';
import { RACE_DEFAULTS, RACE_LIMITS } from '../src/config';
import { parseChoice } from '../src/llm/parseChoice';
import type { Decider } from '../src/mock/mockProvider';
import { loopHint } from '../src/race/loopDetector';
import { buildRaceConfig } from '../src/race/setup';
import { decodeShareConfig, encodeShareConfig } from '../src/ui/shareLink';
import { entrant, makeWiki, runRace, types } from './helpers/race';

const offered = Array.from({ length: 20 }, (_, i) => `Link ${i + 1}`);
const content = (text: string) => parseChoice({ content: text }, offered, true);

describe('bare-number replies', () => {
  it('reads the replies Mistral Nemo actually gave as link numbers', () => {
    expect(content(' 12')).toMatchObject({ kind: 'link', index: 12, title: 'Link 12' });
    expect(content(' 13.')).toMatchObject({ kind: 'link', index: 13 });
    expect(content(' 11, "Captain (association football)"')).toMatchObject({
      kind: 'link',
      index: 11,
      reason: 'Captain (association football)',
    });
    expect(content(' 11, "Reason: John Howard is a former Australian politician."')).toMatchObject({
      kind: 'link',
      index: 11,
      reason: 'John Howard is a former Australian politician.',
    });
    expect(content('#7')).toMatchObject({ kind: 'link', index: 7 });
  });

  it('does not guess at sentences, paragraphs or out-of-range numbers', () => {
    expect(content('12 Angry Men is a film.')).toMatchObject({ kind: 'invalid' });
    expect(content('7\nbecause it looks promising')).toMatchObject({ kind: 'invalid' });
    expect(content(' 99')).toMatchObject({ kind: 'invalid' });
    expect(content('I would pick something about Australia')).toMatchObject({ kind: 'invalid' });
  });

  it('JSON and tool calls still win over the number rule', () => {
    expect(content('{"index": 3}')).toMatchObject({ kind: 'link', index: 3 });
  });
});

describe('visit cap', () => {
  // Start <-> A <-> B loop, Target unreachable, so racers can only bounce around.
  const loop = { Start: ['A', 'B'], A: ['B', 'Start'], B: ['A', 'Start'], Target: [] };
  const preferA: Decider = (req) =>
    req.current.links.includes('A') ? { link: 'A' } : { link: req.current.links[0]! };

  it('defaults to 3 and is clamped to its limits', async () => {
    expect(RACE_DEFAULTS.maxVisitsPerPage).toBe(3);
    const config = await buildRaceConfig(makeWiki(), { start: 'Start', target: 'Target' });
    expect(config.maxVisitsPerPage).toBe(3);
    const d = decodeShareConfig('#maxVisits=500');
    expect(d?.maxVisitsPerPage).toBe(RACE_LIMITS.maxVisitsPerPage.max);
    expect(
      encodeShareConfig({ start: 'S', target: 'T', models: [], maxVisitsPerPage: 2 }),
    ).toContain('maxVisits=2');
  });

  it('stops offering a page once it has been visited the maximum number of times', async () => {
    const a = entrant('a', preferA);
    await runRace({
      entrants: [a, entrant('b', preferA)],
      wiki: makeWiki({}, loop),
      config: { maxVisitsPerPage: 2, maxSteps: 12, circlingThreshold: 100 },
    });
    // Count how often A was actually reached by racer a.
    const arrivalsAtA = a.provider.requests.filter((r) => r.current.title === 'A').length;
    expect(arrivalsAtA).toBeLessThanOrEqual(2);
    // After A's second visit it never appears in the offered links again.
    const lastVisit = a.provider.requests.map((r) => r.current.title).lastIndexOf('A');
    for (const r of a.provider.requests.slice(lastVisit + 1)) {
      expect(r.current.links).not.toContain('A');
    }
    expect(a.provider.requests.some((r) => /no longer offered: "A"/.test(r.hint ?? ''))).toBe(true);
  });

  it('a racer with nowhere left to go ends as stuck instead of looping', async () => {
    const { state, events } = await runRace({
      entrants: [entrant('a', preferA), entrant('b', preferA)],
      wiki: makeWiki({}, loop),
      config: { maxVisitsPerPage: 1, maxSteps: 30, circlingThreshold: 100 },
    });
    expect(state.racers['a']?.status).toBe('stuck');
    expect(types(events, 'a')).toContain('Stuck');
    expect(state.racers['a']!.steps).toBeLessThan(30);
  });

  it('without a cap the same racer loops until it runs out of clicks (old behaviour)', async () => {
    const { state } = await runRace({
      entrants: [entrant('a', preferA), entrant('b', preferA)],
      wiki: makeWiki({}, loop),
      config: { maxSteps: 10, circlingThreshold: 100 },
    });
    expect(state.racers['a']?.status).toBe('gave-up');
  });

  it('the hint tells the model when it has used up a page', () => {
    expect(loopHint('Europe', 3, 3)).toMatch(/maximum allowed/);
    expect(loopHint('Europe', 2, 3)).toBe('You have already visited "Europe" once before.');
  });
});

describe('visit cap and redirects (Catholicism -> Catholic Church)', () => {
  const prefer =
    (...order: string[]): Decider =>
    (req) => {
      const pick = order.find((t) => req.current.links.includes(t));
      return pick ? { link: pick } : { link: req.current.links[0]! };
    };

  it('blocks a redirect name once it is known to lead to a used-up page', async () => {
    const graph = {
      Start: ['Catholicism', 'X'],
      'Catholic Church': ['Y'],
      Y: ['Catholicism', 'Z'],
      X: [],
      Z: [],
      Target: [],
    };
    const a = entrant('a', prefer('Catholicism'));
    await runRace({
      entrants: [a, entrant('b', prefer('Catholicism'))],
      wiki: makeWiki({ redirects: { Catholicism: 'Catholic Church' } }, graph),
      config: { maxVisitsPerPage: 1, maxSteps: 6, circlingThreshold: 100 },
    });
    const atY = a.provider.requests.find((r) => r.current.title === 'Y');
    expect(atY?.current.links).toEqual(['Z']);
  });

  it('cancels, without costing a click, a move through an unseen redirect to a used-up page', async () => {
    const graph = {
      Start: ['Catholic Church', 'X'],
      'Catholic Church': ['Y'],
      Y: ['Catholicism', 'Z'],
      X: [],
      Z: [],
      Target: [],
    };
    const a = entrant('a', prefer('Catholic Church', 'Catholicism'));
    const { events, state } = await runRace({
      entrants: [a, entrant('b', prefer('Catholic Church', 'Catholicism'))],
      wiki: makeWiki({ redirects: { Catholicism: 'Catholic Church' } }, graph),
      config: { maxVisitsPerPage: 1, maxSteps: 6, circlingThreshold: 100 },
    });
    const cancelled = events.find(
      (e) =>
        e.type === 'InvalidChoice' &&
        e.racerId === 'a' &&
        /leads to “Catholic Church”/.test(e.problem),
    );
    expect(cancelled).toMatchObject({ wasted: false });
    // Never a second visit to Catholic Church.
    expect(state.racers['a']?.visits['Catholic Church']).toBe(1);
    // The retry at Y no longer offers the alias, and the hint explains why.
    const retries = a.provider.requests.filter((r) => r.current.title === 'Y');
    expect(retries.at(-1)?.current.links).toEqual(['Z']);
    expect(retries.at(-1)?.hint).toMatch(/Catholicism" leads to "Catholic Church"/);
    // Clicks: Start->Catholic Church, ->Y, ->Z = 3 (the cancelled move is free).
    expect(state.racers['a']?.steps).toBe(3);
  });
});
