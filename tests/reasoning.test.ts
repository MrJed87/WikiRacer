/** Reasoning effort and the reply-token cap, including a reasoning model that runs out of tokens while thinking and returns an empty reply. */
import { describe, expect, it } from 'vitest';
import { RACE_DEFAULTS, RACE_LIMITS } from '../src/config';
import { OpenRouterClient, type LlmFetch } from '../src/llm/openrouter';
import { scriptedDecider } from '../src/mock/behaviours';
import { buildRaceConfig } from '../src/race/setup';
import { decodeShareConfig, encodeShareConfig } from '../src/ui/shareLink';
import { entrant, makeWiki, runRace } from './helpers/race';
import { baseRequest } from './helpers/requests';

function capture(reply: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch: LlmFetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  return { fetch, bodies };
}

const toolReply = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: '',
        tool_calls: [
          { type: 'function', function: { name: 'choose_link', arguments: '{"index":1}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0001 },
};

// Shape of a real reply from a reasoning model that spent its whole token cap thinking and returned no content.
const ranOutThinking = {
  choices: [{ finish_reason: 'length', message: { content: '' } }],
  usage: { prompt_tokens: 787, completion_tokens: 4000, total_tokens: 4787, cost: 0.011587 },
};

describe('OpenRouter request', () => {
  it('sends the same reasoning effort and token cap it is given', async () => {
    const { fetch, bodies } = capture(toolReply);
    const client = new OpenRouterClient({ apiKey: 'k', fetch });
    await client.chooseLink({ ...baseRequest(), reasoningEffort: 'low', maxOutputTokens: 2048 });
    expect(bodies[0]).toMatchObject({
      max_tokens: 2048,
      reasoning: { effort: 'low', exclude: true },
    });
  });

  it('omits reasoning when no effort is set (older configs)', async () => {
    const { fetch, bodies } = capture(toolReply);
    await new OpenRouterClient({ apiKey: 'k', fetch }).chooseLink(baseRequest());
    expect(bodies[0]).not.toHaveProperty('reasoning');
  });

  it('labels a reply cut off at the limit instead of calling it empty', async () => {
    const { fetch } = capture(ranOutThinking);
    const r = await new OpenRouterClient({ apiKey: 'k', fetch }).chooseLink({
      ...baseRequest(),
      maxOutputTokens: 4000,
    });
    expect(r.choice).toMatchObject({ kind: 'invalid' });
    expect(r.choice.kind === 'invalid' && r.choice.problem).toMatch(
      /hit the 4000-token limit.*ran out while thinking/,
    );
    expect(r.usage.costUsd).toBeCloseTo(0.011587);
  });
});

describe('race settings', () => {
  it('default to low effort and 4,000 tokens, and reach every model', async () => {
    expect(RACE_DEFAULTS.reasoningEffort).toBe('low');
    const config = await buildRaceConfig(makeWiki(), { start: 'Start', target: 'Target' });
    expect(config).toMatchObject({ reasoningEffort: 'low', maxOutputTokens: 4000 });

    const a = entrant('a', scriptedDecider(['B', 'Target']));
    const b = entrant('b', scriptedDecider(['A']));
    await runRace({
      entrants: [a, b],
      config: { reasoningEffort: 'medium', maxOutputTokens: 1024 },
    });
    for (const req of [...a.provider.requests, ...b.provider.requests]) {
      expect(req).toMatchObject({ reasoningEffort: 'medium', maxOutputTokens: 1024 });
    }
  });

  it('round-trip through share links, clamped and validated', () => {
    const hash = encodeShareConfig({
      start: 'S',
      target: 'T',
      models: [],
      reasoningEffort: 'none',
      maxOutputTokens: 1500,
    });
    expect(decodeShareConfig(hash)).toMatchObject({
      reasoningEffort: 'none',
      maxOutputTokens: 1500,
    });
    expect(decodeShareConfig('#effort=extreme&maxTokens=999999')).toMatchObject({
      maxOutputTokens: RACE_LIMITS.maxOutputTokens.max,
    });
    expect(decodeShareConfig('#effort=extreme&maxTokens=999999')?.reasoningEffort).toBeUndefined();
  });
});
