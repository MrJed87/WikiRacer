/** Pasted Wikipedia links, custom start validation and the no-arrival summary. */
import { describe, expect, it } from 'vitest';
import { noArrivalSummary } from '../src/race/results';
import { buildRaceConfig } from '../src/race/setup';
import { replay } from '../src/race/store';
import { validateStart, validateTarget } from '../src/wiki/startPicker';
import { parseArticleInput } from '../src/wiki/title';
import type { PageData } from '../src/wiki/types';
import { makeConfig, makeWiki } from './helpers/race';

const title = (raw: string) => {
  const r = parseArticleInput(raw);
  return r.ok ? r.title : `ERR: ${r.reason}`;
};

describe('parseArticleInput', () => {
  it('passes plain titles through canonicalTitle', () => {
    expect(title('john_howard')).toBe('John howard');
    expect(title('  Hongwu Emperor ')).toBe('Hongwu Emperor');
  });

  it('accepts desktop, mobile, schemeless and index.php links', () => {
    expect(title('https://en.wikipedia.org/wiki/Hongwu_Emperor')).toBe('Hongwu Emperor');
    expect(title('https://en.m.wikipedia.org/wiki/John_Howard#Early_life')).toBe('John Howard');
    expect(title('en.wikipedia.org/wiki/John_Howard')).toBe('John Howard');
    expect(title('http://en.wikipedia.org/w/index.php?title=John_Howard&oldid=1')).toBe(
      'John Howard',
    );
  });

  it('decodes percent-encoded titles', () => {
    expect(title('https://en.wikipedia.org/wiki/Caf%C3%A9_culture')).toBe('Café culture');
    expect(title('https://en.wikipedia.org/wiki/AC/DC')).toBe('AC/DC');
  });

  it('rejects other wikis, other sites and links without an article', () => {
    expect(title('https://fr.wikipedia.org/wiki/Paris')).toMatch(/^ERR: Only en\.wikipedia\.org/);
    expect(title('https://example.com/wiki/Paris')).toMatch(/^ERR: Only Wikipedia/);
    expect(title('https://en.wikipedia.org/')).toMatch(/^ERR/);
    expect(title('   ')).toMatch(/^ERR/);
  });
});

describe('validateStart', () => {
  const page = (t: string, links: string[]): PageData => ({
    title: t,
    summary: '',
    links,
    totalLinks: links.length,
    truncated: false,
    isDisambiguation: false,
  });
  const client = (exists: boolean, links: string[], resolved = 'Hongwu Emperor') => ({
    resolveTitle: async () => ({ title: resolved, exists }),
    getPage: async (t: string) => page(t, links),
  });

  it('accepts a pasted link and returns the canonical title', async () => {
    expect(
      await validateStart(
        client(true, ['Ming dynasty']),
        'https://en.wikipedia.org/wiki/Hongwu_Emperor',
      ),
    ).toEqual({ ok: true, title: 'Hongwu Emperor', outgoingLinks: 1 });
  });

  it('rejects missing pages, namespaced pages and dead ends', async () => {
    expect(await validateStart(client(false, []), 'Zzzz')).toMatchObject({ ok: false });
    expect(await validateStart(client(true, ['A']), 'Help:Contents')).toMatchObject({ ok: false });
    expect(await validateStart(client(true, []), 'Lonely page')).toMatchObject({ ok: false });
  });

  it('validateTarget accepts links too', async () => {
    const c = {
      resolveTitle: async () => ({ title: 'John Howard', exists: true }),
      incomingLinkCount: async () => 5,
    };
    expect(await validateTarget(c, 'https://en.wikipedia.org/wiki/John_Howard')).toMatchObject({
      ok: true,
      title: 'John Howard',
    });
  });
});

describe('buildRaceConfig with pasted links (share links, replays)', () => {
  it('normalises URL start and target before loading them', async () => {
    const config = await buildRaceConfig(makeWiki(), {
      start: 'https://en.wikipedia.org/wiki/Start',
      target: 'https://en.wikipedia.org/wiki/Target',
    });
    expect(config.start).toBe('Start');
    expect(config.target).toBe('Target');
  });
});

describe('noArrivalSummary', () => {
  const ids = ['a', 'b'];
  const started = {
    type: 'RaceStarted' as const,
    config: makeConfig(),
    racers: ids.map((id) => ({ id, label: id, colorIndex: 0 })),
    startedAtEpochMs: 0,
    seq: 0,
    t: 0,
  };

  it('names the shared error when every racer failed the same way', () => {
    const msg = 'Could not load the start page: The page you specified doesn’t exist.';
    const state = replay([
      started,
      ...ids.map((racerId, i) => ({
        type: 'AgentFailed' as const,
        racerId,
        kind: 'wiki' as const,
        message: msg,
        seq: i + 1,
        t: 1,
      })),
    ]);
    expect(noArrivalSummary(state)).toBe(`Every racer stopped with the same error: ${msg}`);
  });

  it('counts mixed outcomes instead of blaming step limits', () => {
    const state = replay([
      started,
      { type: 'GaveUp', racerId: 'a', steps: 10, seq: 1, t: 1 },
      { type: 'BudgetExceeded', racerId: 'b', limit: 'usd', seq: 2, t: 2 },
    ]);
    expect(noArrivalSummary(state)).toBe(
      'Nobody reached the target: 1 ran out of clicks, 1 went over budget.',
    );
  });
});
