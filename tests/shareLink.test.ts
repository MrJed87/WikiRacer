import { describe, expect, it } from 'vitest';
import { decodeShareConfig, encodeShareConfig, type ShareableConfig } from '../src/ui/shareLink';

describe('Shareable Config Links', () => {
  it('encodes start, target, and models into hash', () => {
    const config: ShareableConfig = {
      start: 'Philosophy',
      target: 'Six Degrees of Kevin Bacon',
      models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'],
      maxSteps: 25,
      linkCap: 100,
      temperature: 0.1,
      circlingThreshold: 4,
      stopOnFirstArrival: true,
    };

    const hash = encodeShareConfig(config);
    expect(hash).toContain('start=Philosophy');
    expect(hash).toContain('target=Six+Degrees+of+Kevin+Bacon');
    expect(hash).toContain('models=openai%2Fgpt-4o%2Canthropic%2Fclaude-3.5-sonnet');
    expect(hash).toContain('maxSteps=25');
    expect(hash).toContain('linkCap=100');
    expect(hash).toContain('temp=0.1');
    expect(hash).toContain('circling=4');
    expect(hash).toContain('stopFirst=1');
  });

  it('strictly never contains any API key in hash', () => {
    const config: ShareableConfig = {
      start: 'A',
      target: 'B',
      models: ['m1'],
    };
    const hash = encodeShareConfig(config);
    expect(hash.toLowerCase()).not.toContain('key');
    expect(hash.toLowerCase()).not.toContain('sk-');
  });

  it('decodes share config from hash string correctly', () => {
    const hash =
      '#start=Origin+Article&target=Destination+Article&models=model-1%2Cmodel-2&maxSteps=50&linkCap=80&temp=0.3&circling=5&stopFirst=1';
    const decoded = decodeShareConfig(hash);

    expect(decoded).not.toBeNull();
    expect(decoded?.start).toBe('Origin Article');
    expect(decoded?.target).toBe('Destination Article');
    expect(decoded?.models).toEqual(['model-1', 'model-2']);
    expect(decoded?.maxSteps).toBe(50);
    expect(decoded?.linkCap).toBe(80);
    expect(decoded?.temperature).toBe(0.3);
    expect(decoded?.circlingThreshold).toBe(5);
    expect(decoded?.stopOnFirstArrival).toBe(true);
  });

  it('handles empty or invalid hash gracefully', () => {
    expect(decodeShareConfig('')).toBeNull();
    expect(decodeShareConfig('#')).toBeNull();
    expect(decodeShareConfig('   ')).toBeNull();
  });
});
