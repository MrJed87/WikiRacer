import { describe, expect, it } from 'vitest';
import { looksLikeBadStart, pickObscureStart, validateTarget } from '../src/wiki/startPicker';
import { WikiError, type PageData } from '../src/wiki/types';

const page = (title: string, totalLinks = 40, isDisambiguation = false): PageData => ({
  title,
  summary: '',
  links: [],
  totalLinks,
  truncated: false,
  isDisambiguation,
});

function fakeClient(opts: {
  batches: string[][];
  views: Record<string, number>;
  pages: Record<string, PageData>;
  incoming?: Record<string, number>;
}) {
  let batch = 0;
  return {
    randomTitles: async () => opts.batches[batch++] ?? [],
    averageDailyViews: async (titles: string[]) =>
      new Map(titles.filter((t) => t in opts.views).map((t) => [t, opts.views[t] as number])),
    getPage: async (t: string) => {
      const p = opts.pages[t];
      if (!p) throw new WikiError('not-found', 'missing');
      return p;
    },
    incomingLinkCount: async (t: string) => opts.incoming?.[t] ?? 5,
  };
}

describe('looksLikeBadStart', () => {
  it('rejects lists, disambiguation and namespaced titles', () => {
    expect(looksLikeBadStart('List of rivers')).toBe(true);
    expect(looksLikeBadStart('Mercury (disambiguation)')).toBe(true);
    expect(looksLikeBadStart('Help:Contents')).toBe(true);
    expect(looksLikeBadStart('Obscure Bridge')).toBe(false);
  });
});

describe('pickObscureStart', () => {
  it('picks the first obscure, well-connected candidate and skips the rest', async () => {
    const client = fakeClient({
      batches: [
        ['Target', 'Popular', 'List of x', 'Sparse', 'Dead end', 'Disambig', 'Good', 'Later'],
      ],
      views: { Popular: 5000, Sparse: 3, 'Dead end': 3, Disambig: 3, Good: 7, Later: 1 },
      pages: {
        Popular: page('Popular'),
        Sparse: page('Sparse', 4),
        'Dead end': page('Dead end'),
        Disambig: page('Disambig', 40, true),
        Good: page('Good'),
        Later: page('Later'),
      },
      incoming: { 'Dead end': 0 },
    });
    const pick = await pickObscureStart(client, { target: 'Target' });
    expect(pick).toMatchObject({ title: 'Good', avgDailyViews: 7, outgoingLinks: 40, attempts: 1 });
  });

  it('keeps sampling across batches and gives up after maxAttempts', async () => {
    const client = fakeClient({
      batches: [['A'], ['B'], ['C']],
      views: { A: 9999, B: 9999, C: 1 },
      pages: { C: page('C') },
    });
    expect((await pickObscureStart(client, { target: 'T' })).attempts).toBe(3);

    const hopeless = fakeClient({ batches: [['A'], ['A']], views: { A: 9999 }, pages: {} });
    await expect(pickObscureStart(hopeless, { target: 'T', maxAttempts: 2 })).rejects.toMatchObject(
      { kind: 'no-start' },
    );
  });

  it('never picks the target, even via its resolved title', async () => {
    const client = fakeClient({
      batches: [['Alias', 'Other']],
      views: { Alias: 1, Other: 1 },
      pages: { Alias: page('Target'), Other: page('Other') },
    });
    expect((await pickObscureStart(client, { target: 'Target' })).title).toBe('Other');
  });
});

describe('validateTarget', () => {
  const client = (exists: boolean, incoming: number, title = 'Moon') => ({
    resolveTitle: async () => ({ title, exists }),
    incomingLinkCount: async () => incoming,
  });

  it('accepts a resolvable, reachable target', async () => {
    expect(await validateTarget(client(true, 3), 'the moon')).toEqual({
      ok: true,
      title: 'Moon',
      incomingLinks: 3,
    });
  });
  it('rejects empty, namespaced, missing and orphan targets', async () => {
    expect(await validateTarget(client(true, 3), '  ')).toMatchObject({ ok: false });
    expect(await validateTarget(client(true, 3), 'Category:Moons')).toMatchObject({ ok: false });
    expect(await validateTarget(client(false, 0), 'Zzzz')).toMatchObject({ ok: false });
    expect(await validateTarget(client(true, 0), 'Orphan')).toMatchObject({ ok: false });
    expect(await validateTarget(client(true, 3, 'Help:Moon'), 'Moon')).toMatchObject({ ok: false });
  });
});
