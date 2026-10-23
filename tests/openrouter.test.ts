import { describe, expect, it } from 'vitest';
import { OpenRouterClient, testApiKey, type LlmFetch } from '../src/llm/openrouter';
import { fetchModels, normaliseModels, searchModels } from '../src/llm/models';
import { LlmError } from '../src/llm/types';
import { baseRequest } from './helpers/requests';
import { noSleep } from './helpers/fakeFetch';

const KEY = 'sk-or-v1-SECRET-KEY-123';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function scripted(
  replies: Array<{
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    throws?: Error;
  }>,
) {
  const calls: Call[] = [];
  let i = 0;
  const fn: LlmFetch = async (url, init) => {
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, init, body });
    const r = replies[Math.min(i++, replies.length - 1)];
    if (!r) throw new Error('no reply scripted');
    if (r.throws) throw r.throws;
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: r.headers ?? {},
    });
  };
  return { fn, calls };
}

const toolReply = (
  args: string,
  usage: object = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.0012 },
) => ({
  body: {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ type: 'function', function: { name: 'choose_link', arguments: args } }],
        },
      },
    ],
    usage,
  },
});

const client = (
  fn: LlmFetch,
  extra: Partial<ConstructorParameters<typeof OpenRouterClient>[0]> = {},
) =>
  new OpenRouterClient({
    apiKey: KEY,
    fetch: fn,
    referer: 'https://app.example',
    retry: { retries: 2, sleep: noSleep },
    ...extra,
  });

describe('OpenRouterClient.chooseLink', () => {
  it('sends the tool, auth and attribution headers and parses the tool call + usage', async () => {
    const { fn, calls } = scripted([toolReply('{"index": 2, "reason": "river"}')]);
    const result = await client(fn).chooseLink(baseRequest());
    expect(result.choice).toEqual({ kind: 'link', title: 'River', index: 2, reason: 'river' });
    expect(result.usage).toEqual({
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      costUsd: 0.0012,
    });

    const call = calls[0];
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['HTTP-Referer']).toBe('https://app.example');
    expect(headers['X-Title']).toBeTruthy();
    expect(call?.body).toMatchObject({
      model: 'acme/model-a',
      temperature: 0.2,
      usage: { include: true },
      tool_choice: { type: 'function', function: { name: 'choose_link' } },
    });
    expect((call?.body['tools'] as unknown[]).length).toBe(1);
  });

  it('never puts the key in the URL or body', async () => {
    const { fn, calls } = scripted([toolReply('{"index": 1}')]);
    await client(fn).chooseLink(baseRequest());
    expect(calls[0]?.url).not.toContain(KEY);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY);
  });

  it('does not expose the key when serialised or in error text', async () => {
    const c = client(scripted([{ status: 401, body: { error: { message: 'bad key' } } }]).fn);
    expect(JSON.stringify(c)).not.toContain(KEY);
    const err = await c.chooseLink(baseRequest()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('falls back to JSON in content when there is no tool call', async () => {
    const { fn } = scripted([
      { body: { choices: [{ message: { content: '```json\n{"index": 1}\n```' } }] } },
    ]);
    const r = await client(fn).chooseLink(baseRequest());
    expect(r.choice).toMatchObject({ kind: 'link', title: 'Bridge' });
    expect(r.usage.totalTokens).toBe(0);
  });

  it('returns an invalid choice (not an exception) for nonsense picks', async () => {
    const { fn } = scripted([toolReply('{"index": 99}')]);
    expect((await client(fn).chooseLink(baseRequest())).choice.kind).toBe('invalid');
  });

  it('omits tools for models known not to support them, with an otherwise identical request', async () => {
    const { fn, calls } = scripted([
      { body: { choices: [{ message: { content: '{"index": 1}' } }] } },
    ]);
    await client(fn, { noToolsModels: ['acme/model-a'] }).chooseLink(baseRequest());
    expect(calls[0]?.body['tools']).toBeUndefined();
    expect(calls[0]?.body['tool_choice']).toBeUndefined();
    expect(calls[0]?.body['temperature']).toBe(0.2);
  });

  it('retries without tools once when the provider rejects tool use, and remembers', async () => {
    const { fn, calls } = scripted([
      { status: 404, body: { error: { message: 'No endpoints found that support tool use' } } },
      { body: { choices: [{ message: { content: '{"index": 2}' } }] } },
    ]);
    const c = client(fn);
    expect((await c.chooseLink(baseRequest())).choice).toMatchObject({ index: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body['tools']).toBeUndefined();
    await c.chooseLink(baseRequest());
    expect(calls[2]?.body['tools']).toBeUndefined();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [402, 'payment'],
    [404, 'model-unavailable'],
    [400, 'bad-request'],
  ] as const)('HTTP %i is a fatal, non-retried %s error', async (status, kind) => {
    const { fn, calls } = scripted([{ status, body: { error: { message: 'nope' } } }]);
    const err = await client(fn)
      .chooseLink(baseRequest())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind, fatal: true });
    expect(calls).toHaveLength(1);
  });

  it('retries 429 (honouring Retry-After) and 5xx with bounded backoff', async () => {
    const delays: number[] = [];
    const { fn, calls } = scripted([
      { status: 429, body: {}, headers: { 'retry-after': '2' } },
      { status: 503, body: {} },
      toolReply('{"index": 1}'),
    ]);
    const c = client(fn, { retry: { retries: 2, sleep: async (ms) => void delays.push(ms) } });
    expect((await c.chooseLink(baseRequest())).choice.kind).toBe('link');
    expect(calls).toHaveLength(3);
    expect(delays[0]).toBe(2000);
    expect(delays).toHaveLength(2);
  });

  it('gives up after the retry budget with a non-fatal error', async () => {
    const { fn, calls } = scripted([{ status: 500, body: {} }]);
    const err = await client(fn)
      .chooseLink(baseRequest())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'server', fatal: false });
    expect(calls).toHaveLength(3);
  });

  it('maps errors reported inside a 200 body', async () => {
    const { fn } = scripted([{ body: { error: { code: 402, message: 'Insufficient credits' } } }]);
    expect(
      await client(fn)
        .chooseLink(baseRequest())
        .catch((e: unknown) => e),
    ).toMatchObject({ kind: 'payment' });
  });

  it('rejects responses with no choices', async () => {
    const { fn } = scripted([{ body: { choices: [] } }]);
    expect(
      await client(fn)
        .chooseLink(baseRequest())
        .catch((e: unknown) => e),
    ).toMatchObject({ kind: 'bad-response' });
  });

  it('reports network failures as retryable network errors', async () => {
    const { fn, calls } = scripted([{ throws: new TypeError('Failed to fetch') }]);
    expect(
      await client(fn)
        .chooseLink(baseRequest())
        .catch((e: unknown) => e),
    ).toMatchObject({ kind: 'network', retryable: true });
    expect(calls).toHaveLength(3);
  });

  it('reports a timeout when the request never completes', async () => {
    const hang: LlmFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const c = new OpenRouterClient({
      apiKey: KEY,
      fetch: hang,
      timeoutMs: 20,
      retry: { retries: 0, sleep: noSleep },
    });
    expect(await c.chooseLink(baseRequest()).catch((e: unknown) => e)).toMatchObject({
      kind: 'timeout',
    });
  });

  it('reports an external abort as aborted without retrying', async () => {
    const ctrl = new AbortController();
    const hang: LlmFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const c = new OpenRouterClient({
      apiKey: KEY,
      fetch: hang,
      retry: { retries: 3, sleep: noSleep },
    });
    const pending = c.chooseLink(baseRequest({ signal: ctrl.signal })).catch((e: unknown) => e);
    ctrl.abort();
    expect(await pending).toMatchObject({ kind: 'aborted' });
  });
});

describe('testApiKey', () => {
  it('accepts a valid key and reads the label', async () => {
    const { fn, calls } = scripted([{ body: { data: { label: 'my key', limit_remaining: 4.5 } } }]);
    expect(await testApiKey(` ${KEY} `, { fetch: fn })).toEqual({
      ok: true,
      label: 'my key',
      limitRemaining: 4.5,
    });
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/key');
    expect(calls[0]?.url).not.toContain(KEY);
  });
  it('rejects bad, empty and unreachable', async () => {
    expect(await testApiKey(KEY, { fetch: scripted([{ status: 401 }]).fn })).toMatchObject({
      ok: false,
    });
    expect(await testApiKey('  ', { fetch: scripted([{}]).fn })).toMatchObject({ ok: false });
    expect(
      await testApiKey(KEY, { fetch: scripted([{ throws: new Error('x') }]).fn }),
    ).toMatchObject({ ok: false });
  });
});

describe('models', () => {
  const body = {
    data: [
      {
        id: 'a/tools',
        name: 'Zeta Tools',
        context_length: 8000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        supported_parameters: ['tools', 'temperature'],
        architecture: { output_modalities: ['text'] },
      },
      {
        id: 'b/free:free',
        name: 'Alpha Free',
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['temperature'],
        architecture: { output_modalities: ['text'] },
      },
      {
        id: 'c/image',
        name: 'Painter',
        pricing: {},
        architecture: { output_modalities: ['text', 'image'] },
      },
      { id: 'd/notools', name: 'Beta', pricing: { prompt: 'bad' }, supported_parameters: [] },
      { name: 'no id' },
    ],
  };

  it('normalises prices per million tokens, tool support and skips non-text models', () => {
    const models = normaliseModels(body);
    expect(models.map((m) => m.id)).toEqual(['a/tools', 'b/free:free', 'd/notools']);
    expect(models[0]).toMatchObject({
      supportsTools: true,
      promptPerMTok: 3,
      completionPerMTok: 15,
      contextLength: 8000,
      free: false,
    });
    expect(models[1]).toMatchObject({ supportsTools: false, free: true });
    expect(models[2]).toMatchObject({ promptPerMTok: null, free: false });
  });

  it('searches all terms across id and name, tool-capable first', () => {
    const models = normaliseModels(body);
    expect(searchModels(models, '').map((m) => m.id)).toEqual([
      'a/tools',
      'b/free:free',
      'd/notools',
    ]);
    expect(searchModels(models, 'alpha free').map((m) => m.id)).toEqual(['b/free:free']);
    expect(searchModels(models, 'zeta nothing')).toEqual([]);
    expect(searchModels(models, '', 1)).toHaveLength(1);
  });

  it('fetches without a key and throws typed errors', async () => {
    const { fn, calls } = scripted([{ body }]);
    expect(await fetchModels({ fetch: fn })).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/models');
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.['Authorization'],
    ).toBeUndefined();
    await expect(fetchModels({ fetch: scripted([{ status: 500 }]).fn })).rejects.toBeInstanceOf(
      LlmError,
    );
    await expect(
      fetchModels({ fetch: scripted([{ throws: new Error('x') }]).fn }),
    ).rejects.toMatchObject({ kind: 'network' });
    expect(() => normaliseModels({})).toThrow(LlmError);
  });
});
