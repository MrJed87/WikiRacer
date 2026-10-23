import { describe, expect, it } from 'vitest';
import { WikipediaClient } from '../src/wiki/client';
import { WikiError } from '../src/wiki/types';
import html from './fixtures/example-town.html?raw';
import { fakeFetch, noSleep } from './helpers/fakeFetch';

const make = (handler: Parameters<typeof fakeFetch>[0], retries = 2) => {
  const f = fakeFetch(handler);
  return { f, client: new WikipediaClient({ fetch: f, retry: { retries, sleep: noSleep } }) };
};

describe('WikipediaClient.getPage', () => {
  it('requests origin=* parse and extracts links', async () => {
    const { f, client } = make(() => ({ body: { parse: { title: 'Example Town', text: html } } }));
    const page = await client.getPage('example_Town');
    expect(page.title).toBe('Example Town');
    expect(page.links[0]).toBe('Infobox Link');
    expect(page.links).not.toContain('Example Town');
    const url = f.calls[0];
    expect(url?.searchParams.get('origin')).toBe('*');
    expect(url?.searchParams.get('action')).toBe('parse');
    expect(url?.searchParams.get('page')).toBe('Example Town');
    expect(url?.searchParams.get('redirects')).toBe('1');
  });

  it('caches by canonical title and shares in-flight requests', async () => {
    const { f, client } = make(() => ({ body: { parse: { title: 'Example Town', text: html } } }));
    await Promise.all([client.getPage('Example_Town'), client.getPage('Example Town')]);
    await client.getPage('Example Town');
    expect(f.calls).toHaveLength(1);
  });

  it('aliases redirects to the resolved title in the cache', async () => {
    const { f, client } = make(() => ({ body: { parse: { title: 'Example Town', text: html } } }));
    const viaRedirect = await client.getPage('Exampleville');
    expect(viaRedirect.title).toBe('Example Town');
    await client.getPage('Example Town');
    expect(f.calls).toHaveLength(1);
  });

  it('maps missing pages to not-found without retrying', async () => {
    const { f, client } = make(() => ({
      body: { error: { code: 'missingtitle', info: "The page you specified doesn't exist." } },
    }));
    await expect(client.getPage('Nope')).rejects.toMatchObject({ kind: 'not-found' });
    expect(f.calls).toHaveLength(1);
  });

  it('retries 429 and 5xx then succeeds', async () => {
    let n = 0;
    const { f, client } = make(() => {
      n++;
      if (n === 1) return { status: 429, body: {} };
      if (n === 2) return { status: 503, body: {} };
      return { body: { parse: { title: 'X', text: '<p>hi</p>' } } };
    });
    expect((await client.getPage('X')).summary).toBe('hi');
    expect(f.calls).toHaveLength(3);
  });

  it('gives up after bounded retries and does not cache failures', async () => {
    let fail = true;
    const { f, client } = make(
      () => (fail ? { status: 500, body: {} } : { body: { parse: { title: 'X', text: '' } } }),
      1,
    );
    await expect(client.getPage('X')).rejects.toBeInstanceOf(WikiError);
    expect(f.calls).toHaveLength(2);
    fail = false;
    await expect(client.getPage('X')).resolves.toMatchObject({ title: 'X' });
  });

  it('rejects malformed responses', async () => {
    const { client } = make(() => ({ body: { parse: { title: 'X' } } }));
    await expect(client.getPage('X')).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});

describe('other WikipediaClient calls', () => {
  it('resolveTitle follows redirects and reports missing pages', async () => {
    const { client } = make((p) =>
      p.get('titles') === 'Ghost'
        ? { body: { query: { pages: [{ title: 'Ghost', missing: true }] } } }
        : { body: { query: { pages: [{ title: 'United States' }] } } },
    );
    expect(await client.resolveTitle('usa')).toEqual({ title: 'United States', exists: true });
    expect(await client.resolveTitle('Ghost')).toEqual({ title: 'Ghost', exists: false });
  });

  it('search reads opensearch titles', async () => {
    const { client } = make(() => ({ body: ['cat', ['Cat', 'Catalonia'], [], []] }));
    expect(await client.search('cat')).toEqual(['Cat', 'Catalonia']);
    expect(await client.search('  ')).toEqual([]);
  });

  it('randomTitles returns canonical titles', async () => {
    const { client } = make(() => ({
      body: { query: { random: [{ title: 'Foo_bar' }, { title: 'Baz' }] } },
    }));
    expect(await client.randomTitles(2)).toEqual(['Foo bar', 'Baz']);
  });

  it('averageDailyViews averages days and treats nulls as zero', async () => {
    const { client } = make(() => ({
      body: {
        query: {
          pages: [
            { title: 'A', pageviews: { d1: 10, d2: 30, d3: null, d4: null } },
            { title: 'B' },
          ],
        },
      },
    }));
    const views = await client.averageDailyViews(['A', 'B']);
    expect(views.get('A')).toBe(10);
    expect(views.get('B')).toBe(0);
  });

  it('incomingLinkCount counts backlinks', async () => {
    const { client } = make(() => ({
      body: { query: { backlinks: [{ title: 'a' }, { title: 'b' }] } },
    }));
    expect(await client.incomingLinkCount('X')).toBe(2);
  });
});
