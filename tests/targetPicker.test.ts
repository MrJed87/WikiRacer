/** Random well-known targets. */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_TARGETS,
  VITAL_LIST_PAGES,
  loadTargetPool,
  pickRandomTarget,
} from '../src/wiki/targetPicker';

const vital = Array.from({ length: 300 }, (_, i) => `Topic ${i}`).concat('List of things');

const client = (
  opts: { pages?: Record<string, string[]>; failing?: boolean; missing?: string[] } = {},
) => {
  const calls: string[] = [];
  return {
    calls,
    linkedArticles: async (page: string) => {
      calls.push(page);
      if (opts.failing) throw new Error('rate limited');
      return opts.pages?.[page] ?? [];
    },
    resolveTitle: async (t: string) => ({ title: t, exists: !(opts.missing ?? []).includes(t) }),
    incomingLinkCount: async () => 5,
  };
};

describe('target pool', () => {
  it('uses the first Vital Articles page that yields a real list, once per client', async () => {
    const c = client({ pages: { [VITAL_LIST_PAGES[1]]: vital } });
    const pool = await loadTargetPool(c);
    expect(pool.source).toBe('vital');
    expect(pool.titles).toHaveLength(300);
    expect(pool.titles).not.toContain('List of things');
    await loadTargetPool(c);
    expect(c.calls).toEqual([...VITAL_LIST_PAGES]);
  });

  it('falls back to the built-in list if Wikipedia fails or the page is too short', async () => {
    expect((await loadTargetPool(client({ failing: true }))).source).toBe('fallback');
    const short = await loadTargetPool(client({ pages: { [VITAL_LIST_PAGES[0]]: ['A', 'B'] } }));
    expect(short).toEqual({ titles: FALLBACK_TARGETS, source: 'fallback' });
    expect(FALLBACK_TARGETS.length).toBeGreaterThanOrEqual(100);
  });
});

describe('pickRandomTarget', () => {
  it('never picks the start, and skips candidates that fail validation', async () => {
    const pages = { [VITAL_LIST_PAGES[0]]: ['Moon', 'Sun', ...vital.slice(0, 250)] };
    let n = 0;
    // Deterministic rng: first tries index 0 (Moon = start), then 1 (Sun = missing), then 2.
    const rng = () => [0, 0.004, 0.008][n++ % 3]!;
    const pick = await pickRandomTarget(client({ pages, missing: ['Sun'] }), {
      exclude: ['Moon'],
      rng,
    });
    expect(pick.title).not.toBe('Moon');
    expect(pick.title).not.toBe('Sun');
    expect(pick.source).toBe('vital');
  });

  it('gives up with a clear error rather than looping forever', async () => {
    const c = client({ failing: true, missing: [...FALLBACK_TARGETS] });
    await expect(pickRandomTarget(c)).rejects.toThrow(/Could not pick a random target/);
  });
});
