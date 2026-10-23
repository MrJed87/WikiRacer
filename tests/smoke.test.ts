import { describe, expect, it } from 'vitest';
import { createDemoWiki, DEMO_START, DEMO_TARGET } from '../src/mock/demoWorld';
import { MockProvider } from '../src/mock/mockProvider';
import { shortestPathDecider, wandererDecider, seededRandom } from '../src/mock/behaviours';
import { RaceManager, type Entrant } from '../src/race/raceManager';
import { buildRaceConfig } from '../src/race/setup';
import { computeResults } from '../src/race/results';
import { createGraph, applyEvent, describeGraph } from '../src/graph/graphModel';
import { ReplayController, validateReplayData, type ReplayData } from '../src/race/replay';
import { decodeShareConfig, encodeShareConfig } from '../src/ui/shareLink';

describe('End-to-End Race Lifecycle Smoke Test', () => {
  it('runs setup -> race execution -> results -> replay export and playback', async () => {
    // 1. Setup & Configuration
    const wiki = createDemoWiki(42);
    const distances = wiki.distancesTo(DEMO_TARGET);

    const entrants: Entrant[] = [
      {
        racer: { id: 'smart-model', label: 'Smart Racer', colorIndex: 0 },
        provider: new MockProvider(shortestPathDecider(distances), { latencyMs: 1 }),
      },
      {
        racer: { id: 'wanderer-model', label: 'Wanderer Racer', colorIndex: 1 },
        provider: new MockProvider(wandererDecider(seededRandom(12)), { latencyMs: 1 }),
      },
    ];

    const config = await buildRaceConfig(wiki, {
      start: DEMO_START,
      target: DEMO_TARGET,
      overrides: {
        maxSteps: 15,
        stepDelayMs: 0,
        stopOnFirstArrival: true,
      },
    });

    expect(config.start).toBe(DEMO_START);
    expect(config.target).toBe(DEMO_TARGET);

    // 2. Race Execution
    const manager = new RaceManager({
      entrants,
      wiki,
      config,
      sleep: async () => {}, // Instant for tests
    });

    const graph = createGraph();
    manager.store.subscribe((event) => {
      applyEvent(graph, event);
    });

    await manager.start();

    // 3. Post-Race State & Results
    const finalState = manager.store.state;
    expect(finalState.status).toBe('finished');
    expect(finalState.winnerId).toBe('smart-model');

    const results = computeResults(finalState);
    expect(results.fastestId).toBe('smart-model');
    expect(results.standings.length).toBe(2);
    expect(results.standings[0]?.racerId).toBe('smart-model');
    expect(results.standings[0]?.status).toBe('arrived');

    // 4. Accessibility Text Description
    const summary = describeGraph(graph, (id) => (id === 'smart-model' ? 'Smart Racer' : id));
    expect(summary).toContain('Smart Racer: arrived');
    expect(summary).toContain('articles visited or targeted');

    // 5. Replay Export Data
    const replayExport: ReplayData = {
      app: 'Wikipedia Graph Race',
      version: 1,
      exportedAt: new Date().toISOString(),
      config: finalState.config!,
      racers: entrants.map((e) => e.racer),
      events: [...manager.store.events],
    };

    expect(() => validateReplayData(replayExport)).not.toThrow();

    // 6. Replay Controller Playback & Seeking
    const replay = new ReplayController(replayExport);
    expect(replay.totalEvents).toBe(manager.store.events.length);

    let observedStateAtFinish = '';
    replay.seek(replay.totalEvents);
    replay.subscribe(({ state }) => {
      observedStateAtFinish = state.racers['smart-model']?.status ?? '';
    });
    expect(observedStateAtFinish).toBe('arrived');

    // Seek back to start
    replay.seek(1); // after RaceStarted
    let observedAtStart = '';
    replay.subscribe(({ state }) => {
      observedAtStart = state.racers['smart-model']?.status ?? '';
    });
    expect(observedAtStart).toBe('racing');

    // 7. Share Link Roundtrip
    const shareHash = encodeShareConfig({
      start: config.start,
      target: config.target,
      models: entrants.map((e) => e.racer.id),
      maxSteps: config.maxSteps,
    });
    expect(shareHash).toContain('start=');

    const decoded = decodeShareConfig(shareHash);
    expect(decoded?.start).toBe(config.start);
    expect(decoded?.target).toBe(config.target);
    expect(decoded?.models).toEqual(entrants.map((e) => e.racer.id));
  });
});
