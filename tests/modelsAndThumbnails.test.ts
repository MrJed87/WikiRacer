/** Account-filtered model list, family-aware presets and node thumbnails. */
import { describe, expect, it } from 'vitest';
import {
  choosePreset,
  fetchModels,
  modelFamily,
  pickDistinctFamilies,
  type ModelInfo,
} from '../src/llm/models';
import { ThumbnailLoader } from '../src/ui/thumbnails';
import { WIKI } from '../src/config';
import { createLimiter } from '../src/util/async';
import { WikipediaClient, isWikimediaImage } from '../src/wiki/client';
import realPageImages from './fixtures/pageimages-2026-10.json?raw';
import viteConfig from '../vite.config.ts?raw';

const m = (
  id: string,
  prompt: number | null,
  completion: number | null,
  extra: Partial<ModelInfo> = {},
): ModelInfo => ({
  id,
  name: id,
  supportsTools: true,
  promptPerMTok: prompt,
  completionPerMTok: completion,
  contextLength: 128_000,
  free: prompt === 0 && completion === 0,
  ...extra,
});

describe('modelFamily', () => {
  it('groups by vendor and the first word of the model name', () => {
    expect(modelFamily('deepseek/deepseek-v4.1-flash')).toBe('deepseek/deepseek');
    expect(modelFamily('deepseek/deepseek-v4-pro-0813')).toBe('deepseek/deepseek');
    expect(modelFamily('google/gemma-4-27b-it:free')).toBe('google/gemma');
    expect(modelFamily('google/gemini-3.8-flash')).toBe('google/gemini');
    expect(modelFamily('qwen/qwen3.8-flash')).toBe('qwen/qwen');
    expect(modelFamily('openai/gpt-6-luna')).toBe(modelFamily('openai/gpt-6.1-sol'));
  });

  it('pickDistinctFamilies keeps the first of each family', () => {
    const picked = pickDistinctFamilies([
      m('deepseek/deepseek-a', 1, 1),
      m('deepseek/deepseek-b', 1, 1),
      m('google/gemma-x', 1, 1),
      m('google/gemma-y', 1, 1),
      m('google/gemini-z', 1, 1),
    ]);
    expect(picked.map((x) => x.id)).toEqual([
      'deepseek/deepseek-a',
      'google/gemma-x',
      'google/gemini-z',
    ]);
  });
});

describe('choosePreset', () => {
  const catalogue = [
    m('deepseek/deepseek-v4.1-flash', 0.03, 0.14),
    m('deepseek/deepseek-v4-flash-0731', 0.04, 0.13),
    m('google/gemma-4-9b', 0.02, 0.04),
    m('google/gemma-4-27b', 0.03, 0.06),
    m('qwen/qwen3.8-flash', 0.15, 0.47),
    m('z-ai/glm-5.3-flash', 0.15, 0.5),
    m('anthropic/claude-haiku-5.5', 0.1, 0.5),
    m('anthropic/claude-haiku-5.5:batch', 0.05, 0.25),
    m('openai/gpt-6.1-sol', 2, 10),
    m('meta/llama-free:free', 0, 0),
    m('mistral/mistral-free:free', 0, 0),
    m('mistral/mistral-other:free', 0, 0),
    m('tiny/tiny-ctx', 0.001, 0.001, { contextLength: 4_000 }),
    m('unpriced/unknown', null, null),
  ];

  it('fast: the 4 cheapest paid models, one per family', () => {
    expect(choosePreset('fast', catalogue).map((x) => x.id)).toEqual([
      'google/gemma-4-9b',
      'deepseek/deepseek-v4.1-flash',
      'anthropic/claude-haiku-5.5',
      'qwen/qwen3.8-flash',
    ]);
  });

  it('fast: skips batch variants, tiny contexts, unpriced and free models', () => {
    const ids = choosePreset('fast', catalogue).map((x) => x.id);
    expect(ids).not.toContain('anthropic/claude-haiku-5.5:batch');
    expect(ids).not.toContain('tiny/tiny-ctx');
    expect(ids).not.toContain('unpriced/unknown');
    expect(ids.some((id) => id.endsWith(':free'))).toBe(false);
  });

  it('free: free models, one per family', () => {
    expect(choosePreset('free', catalogue).map((x) => x.id)).toEqual([
      'meta/llama-free:free',
      'mistral/mistral-free:free',
    ]);
  });

  it('flagship: only models the account can run, never doubling a family', () => {
    const ids = choosePreset('flagship', catalogue).map((x) => x.id);
    expect(ids[0]).toBe('openai/gpt-6.1-sol');
    expect(ids).toHaveLength(4);
    expect(new Set(ids.map(modelFamily)).size).toBe(4);
    for (const id of ids) expect(catalogue.some((c) => c.id === id)).toBe(true);
  });
});

describe('fetchModels for an account', () => {
  it('uses /models/user with the key when one is given, /models without', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers['Authorization'] });
      return new Response(JSON.stringify({ data: [{ id: 'a/b', name: 'B' }] }), { status: 200 });
    };
    await fetchModels({ fetch, apiKey: ' sk-test ' });
    await fetchModels({ fetch });
    expect(calls[0]).toEqual({
      url: 'https://openrouter.ai/api/v1/models/user',
      auth: 'Bearer sk-test',
    });
    expect(calls[1]).toEqual({ url: 'https://openrouter.ai/api/v1/models', auth: undefined });
  });

  it('throws on a refused filtered list so the UI can fall back', async () => {
    const fetch = async () => new Response('{}', { status: 403 });
    await expect(fetchModels({ fetch, apiKey: 'k' })).rejects.toThrow();
  });
});

describe('WikipediaClient.getThumbnails', () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  it('batches titles, follows redirects, keeps only Wikimedia URLs and caches', async () => {
    const urls: string[] = [];
    const client = new WikipediaClient({
      fetch: async (url) => {
        urls.push(url);
        return json({
          query: {
            redirects: [{ from: 'USA', to: 'United States' }],
            pages: [
              {
                title: 'United States',
                thumbnail: { source: 'https://upload.wikimedia.org/us.png' },
              },
              { title: 'Moon', thumbnail: { source: 'https://evil.example/moon.png' } },
              { title: 'Nothing' },
            ],
          },
        });
      },
    });
    const first = await client.getThumbnails(['USA', 'Moon', 'Nothing']);
    expect(first.get('USA')).toBe('https://upload.wikimedia.org/us.png');
    expect(first.get('Moon')).toBeNull();
    expect(first.get('Nothing')).toBeNull();
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).searchParams.get('prop')).toBe('pageimages');

    await client.getThumbnails(['USA', 'Moon']);
    expect(urls).toHaveLength(1);
  });

  it('splits more than 50 titles into several requests', async () => {
    let requests = 0;
    const client = new WikipediaClient({
      fetch: async () => {
        requests++;
        return json({ query: { pages: [] } });
      },
    });
    await client.getThumbnails(Array.from({ length: 120 }, (_, i) => `T${i}`));
    expect(requests).toBe(3);
  });
});

describe('ThumbnailLoader', () => {
  it('debounces bursts into one fetch, skips known titles and retries failures', async () => {
    const batches: string[][] = [];
    let fail = true;
    const timers: Array<() => void> = [];
    const applied: string[] = [];
    const loader = new ThumbnailLoader({
      source: {
        getThumbnails: async (titles) => {
          batches.push([...titles]);
          if (fail) throw new Error('rate limited');
          return new Map(
            titles.map((t) => [t, t === 'B' ? null : `https://upload.wikimedia.org/${t}`]),
          );
        },
      },
      apply: (t) => applied.push(t),
      setTimer: (fn) => timers.push(fn),
    });

    loader.request(['A', 'B']);
    loader.request(['B', 'C']);
    expect(timers).toHaveLength(1);
    await loader.flush();
    expect(batches).toEqual([['A', 'B', 'C']]);

    fail = false;
    loader.request(['A', 'B', 'C']);
    await loader.flush();
    expect(applied).toEqual(['A', 'C']);

    loader.request(['A', 'C']);
    await loader.flush();
    expect(batches).toHaveLength(2);
  });
});

describe('real Wikipedia thumbnail responses (fixture captured 2026-10-22)', () => {
  it('accepts thumb.wikimedia.org URLs as served today', async () => {
    const client = new WikipediaClient({
      fetch: async () => new Response(realPageImages, { status: 200 }),
      limiter: createLimiter(1),
    });
    const thumbs = await client.getThumbnails([
      'John Howard',
      'Europe',
      'Netherlands',
      'Gillingham F.C.',
    ]);
    expect(thumbs.get('John Howard')).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(thumbs.get('Europe')).toMatch(/^https:\/\/thumb\.wikimedia\.org\//);
    expect(thumbs.get('Gillingham F.C.')).toBeNull();
  });

  it('only allows https on Wikimedia image hosts, and the CSP allows every one of them', () => {
    expect(isWikimediaImage('https://upload.wikimedia.org/a.png')).toBe(true);
    expect(isWikimediaImage('https://thumb.wikimedia.org/a.png')).toBe(true);
    expect(isWikimediaImage('http://thumb.wikimedia.org/a.png')).toBe(false);
    expect(isWikimediaImage('https://thumb.wikimedia.org.evil.example/a.png')).toBe(false);
    for (const host of WIKI.imageHosts) expect(viteConfig).toContain(`https://${host}`);
  });
});
