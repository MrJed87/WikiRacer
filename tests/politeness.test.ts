/** Wikimedia politeness (one request at a time, 100ms apart, identified) and lockstep rounds. */
import { describe, expect, it } from 'vitest';
import { RACE_DEFAULTS, WIKI } from '../src/config';
import { looperDecider } from '../src/mock/behaviours';
import { buildRaceConfig } from '../src/race/setup';
import { RoundBarrier } from '../src/race/rounds';
import type { RaceEvent } from '../src/race/types';
import { createLimiter } from '../src/util/async';
import { API_USER_AGENT, WikipediaClient } from '../src/wiki/client';
import { entrant, makeWiki, runRace } from './helpers/race';

describe('Wikipedia request queue', () => {
  it('defaults follow the robot policy: 1 at a time, 100ms gap', () => {
    expect(WIKI.maxConcurrentRequests).toBe(1);
    expect(WIKI.requestGapMs).toBe(100);
  });

  it('runs one task at a time and pauses between them', async () => {
    const log: string[] = [];
    const limit = createLimiter(1, {
      gapMs: 100,
      sleep: async (ms) => {
        log.push(`sleep ${ms}`);
      },
    });
    let running = 0;
    let maxRunning = 0;
    const task = (name: string) =>
      limit(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${name}`);
        await Promise.resolve();
        running--;
        return name;
      });
    expect(await Promise.all([task('a'), task('b'), task('c')])).toEqual(['a', 'b', 'c']);
    expect(maxRunning).toBe(1);
    expect(log).toEqual(['start a', 'sleep 100', 'start b', 'sleep 100', 'start c', 'sleep 100']);
  });

  it('really waits about 100ms between requests by default', async () => {
    const starts: number[] = [];
    const client = new WikipediaClient({
      fetch: async () => {
        starts.push(performance.now());
        return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
      },
    });
    await Promise.all([client.getThumbnails(['A']), client.getThumbnails(['B'])]);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(95);
  });

  it('two separate clients share the same queue', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
    };
    const a = new WikipediaClient({ fetch });
    const b = new WikipediaClient({ fetch });
    await Promise.all([a.getThumbnails(['X']), b.getThumbnails(['Y'])]);
    expect(maxInFlight).toBe(1);
  });

  it('identifies itself with Api-User-Agent on every request', async () => {
    const seen: Array<string | undefined> = [];
    const client = new WikipediaClient({
      fetch: async (_url, init) => {
        seen.push(init?.headers?.['Api-User-Agent']);
        return new Response(JSON.stringify({ query: { pages: [] } }), { status: 200 });
      },
      limiter: createLimiter(1),
    });
    await client.getThumbnails(['A']);
    expect(seen).toEqual([API_USER_AGENT]);
    expect(API_USER_AGENT).toMatch(/^WikipediaGraphRace\/\S+ \(.+\)$/);
  });
});

describe('RoundBarrier', () => {
  it('releases a round only when every active racer has arrived', async () => {
    const b = new RoundBarrier(['a', 'b']);
    let aThrough = false;
    const pa = b.wait('a').then(() => (aThrough = true));
    await Promise.resolve();
    expect(aThrough).toBe(false);
    await b.wait('b');
    await pa;
    expect(aThrough).toBe(true);
    expect(b.round).toBe(1);
  });

  it('stops waiting for racers that have finished', async () => {
    const b = new RoundBarrier(['a', 'b']);
    const pa = b.wait('a');
    b.leave('b');
    await pa;
    expect(b.round).toBe(1);
    await b.wait('a');
    expect(b.round).toBe(2);
  });

  it('releaseAll frees waiting racers when the race stops', async () => {
    const b = new RoundBarrier(['a', 'b']);
    const pa = b.wait('a');
    b.releaseAll();
    await expect(pa).resolves.toBeUndefined();
  });
});

describe('lockstep races', () => {
  const steps = (events: readonly RaceEvent[]) =>
    events.flatMap((e) =>
      e.type === 'StepTaken' || e.type === 'WentBack' ? [{ id: e.racerId, step: e.step }] : [],
    );

  it('is on by default', async () => {
    const config = await buildRaceConfig(makeWiki(), { start: 'Start', target: 'Target' });
    expect(config.lockstep).toBe(true);
    expect(RACE_DEFAULTS.lockstep).toBe(true);
  });

  it('a fast model never gets more than one click ahead of a slow one', async () => {
    const { events } = await runRace({
      entrants: [
        entrant('fast', looperDecider()),
        entrant('slow', looperDecider(), { latencyMs: 15 }),
      ],
      config: { lockstep: true, maxSteps: 6, circlingThreshold: 100 },
    });
    const done = { fast: 0, slow: 0 };
    for (const s of steps(events)) {
      done[s.id as 'fast' | 'slow'] = s.step;
      expect(Math.abs(done.fast - done.slow)).toBeLessThanOrEqual(1);
    }
    expect(done).toEqual({ fast: 6, slow: 6 });
  });

  it('without lockstep the fast model runs ahead (control)', async () => {
    const { events } = await runRace({
      entrants: [
        entrant('fast', looperDecider()),
        entrant('slow', looperDecider(), { latencyMs: 15 }),
      ],
      config: { lockstep: false, maxSteps: 6, circlingThreshold: 100 },
    });
    const firstSlow = steps(events).findIndex((s) => s.id === 'slow');
    const fastBefore = steps(events)
      .slice(0, firstSlow)
      .filter((s) => s.id === 'fast').length;
    expect(fastBefore).toBeGreaterThan(1);
  });
});
