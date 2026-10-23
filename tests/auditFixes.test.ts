/** Regression tests for cross-cutting invariants: CSP-safe markup, the link cap, preset matching and setting bounds. */
import { describe, expect, it } from 'vitest';
import { RACE_DEFAULTS, RACE_LIMITS, clampSetting } from '../src/config';
import { FLAGSHIP_IDS, choosePreset, type ModelInfo } from '../src/llm/models';
import { scriptedDecider } from '../src/mock/behaviours';
import { decodeShareConfig } from '../src/ui/shareLink';
import { entrant, makeWiki, runRace } from './helpers/race';

// Loaded through Vite so the test needs no Node typings, like the fixture imports elsewhere.
const sources: Record<string, string> = import.meta.glob(['../src/**/*.ts', '../index.html'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('no inline style attributes (the production CSP is style-src self)', () => {
  it('src and index.html contain no style="..." attributes', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const offenders = Object.entries(sources)
      .filter(([, text]) => /\sstyle\s*=\s*["'`]/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

describe('the race link cap reaches the models', () => {
  const wide = {
    Start: Array.from({ length: 40 }, (_, i) => `L${i}`).concat('Target'),
    Target: [],
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`L${i}`, ['Start']])),
  };

  it('offers at most config.linkCap links and flags truncation', async () => {
    const a = entrant('a', scriptedDecider([]));
    const b = entrant('b', scriptedDecider([]));
    await runRace({
      entrants: [a, b],
      wiki: makeWiki({}, wide),
      config: { linkCap: 25, maxSteps: 1 },
    });
    const req = a.provider.requests[0];
    expect(req?.current.links).toHaveLength(25);
    expect(req?.current.truncated).toBe(true);
    expect(req?.current.totalLinks).toBe(41);
    // Fairness: both racers saw the identical list.
    expect(b.provider.requests[0]?.current.links).toEqual(req?.current.links);
  });

  it('leaves pages under the cap untouched', async () => {
    const a = entrant('a', scriptedDecider([]));
    await runRace({
      entrants: [a, entrant('b', scriptedDecider([]))],
      wiki: makeWiki({}, wide),
      config: { linkCap: 300, maxSteps: 1 },
    });
    expect(a.provider.requests[0]?.current.links).toHaveLength(41);
    expect(a.provider.requests[0]?.current.truncated).toBe(false);
  });
});

describe('presets match model IDs exactly', () => {
  const m = (id: string): ModelInfo => ({
    id,
    name: id,
    supportsTools: true,
    promptPerMTok: 1,
    completionPerMTok: 1,
    contextLength: 100_000,
    free: false,
  });

  it('never picks a longer variant that merely contains a flagship ID', () => {
    const id = FLAGSHIP_IDS[0];
    const picked = choosePreset('flagship', [m(`${id}-preview`), m(`${id}:batch`), m(id)]);
    expect(picked.map((x) => x.id)).toEqual([id]);
  });

  it('skips flagship IDs the catalogue lacks instead of inventing them', () => {
    const picked = choosePreset('flagship', [m(FLAGSHIP_IDS[1])]);
    expect(picked.map((x) => x.id)).toEqual([FLAGSHIP_IDS[1]]);
  });
});

describe('settings are clamped to RACE_LIMITS', () => {
  it('clampSetting bounds values and falls back to defaults for non-numbers', () => {
    expect(clampSetting('linkCap', 100_000)).toBe(RACE_LIMITS.linkCap.max);
    expect(clampSetting('maxSteps', 1)).toBe(RACE_LIMITS.maxSteps.min);
    expect(clampSetting('temperature', 0)).toBe(0);
    expect(clampSetting('temperature', NaN)).toBe(RACE_DEFAULTS.temperature);
  });

  it('share links cannot set extreme values', () => {
    const d = decodeShareConfig('#maxSteps=99999&linkCap=99999&temp=7&circling=0');
    expect(d?.maxSteps).toBe(RACE_LIMITS.maxSteps.max);
    expect(d?.linkCap).toBe(RACE_LIMITS.linkCap.max);
    expect(d?.temperature).toBe(RACE_LIMITS.temperature.max);
    expect(d?.circlingThreshold).toBe(RACE_LIMITS.circlingThreshold.min);
  });
});
