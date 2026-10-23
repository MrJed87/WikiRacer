import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION, buildMessages, buildUserPrompt, formatPath } from '../src/llm/prompt';
import { baseRequest } from './helpers/requests';

describe('prompt', () => {
  it('numbers links from 1 and states target, step and path', () => {
    const p = buildUserPrompt(baseRequest());
    expect(p).toContain('TARGET: Philosophy');
    expect(p).toContain('Click 1 of at most 30.');
    expect(p).toContain('1. Bridge\n2. River');
    expect(p).toContain('Path so far: Obscure Bridge');
    expect(p).not.toContain('go back');
  });

  it('mentions going back and the previous page when allowed', () => {
    const p = buildUserPrompt(baseRequest({ canGoBack: true, path: ['Start', 'Obscure Bridge'] }));
    expect(p).toContain('go back to "Start"');
  });

  it('notes truncation, dead ends and hints', () => {
    const capped = buildUserPrompt(
      baseRequest({ current: { ...baseRequest().current, totalLinks: 400, truncated: true } }),
    );
    expect(capped).toContain('(first 2 of 400)');
    const dead = buildUserPrompt(
      baseRequest({ current: { ...baseRequest().current, links: [], totalLinks: 0 } }),
    );
    expect(dead).toContain('dead end');
    expect(buildUserPrompt(baseRequest({ hint: 'You visited River twice.' }))).toContain(
      'Note: You visited River twice.',
    );
  });

  it('trims long paths to head and tail', () => {
    const path = Array.from({ length: 30 }, (_, i) => `P${i}`);
    const text = formatPath(path);
    expect(text).toContain('P0 → P1 → … (18 more) … → P20');
    expect(text.endsWith('P29')).toBe(true);
    expect(formatPath(['A', 'B'])).toBe('A → B');
  });

  it('is identical for every model (fairness)', () => {
    const a = buildMessages(baseRequest({ model: 'openai/gpt-x' }));
    const b = buildMessages(baseRequest({ model: 'anthropic/claude-y' }));
    expect(a).toEqual(b);
    expect(a[0]?.content).toContain('untrusted');
    expect(PROMPT_VERSION).toBeGreaterThan(0);
  });
});
