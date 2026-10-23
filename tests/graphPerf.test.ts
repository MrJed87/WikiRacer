import { describe, expect, it } from 'vitest';
import { GraphSimulation } from '../src/graph/simulation';
import { buildGraph } from '../src/graph/graphModel';
import { ZERO_USAGE } from '../src/llm/types';
import type { RaceEvent, Racer } from '../src/race/types';
import { makeConfig } from './helpers/race';

describe('Graph performance pass (6 racers, 500+ nodes)', () => {
  it('handles 6 racers traversing 600 nodes smoothly', () => {
    const racers: Racer[] = Array.from({ length: 6 }, (_, i) => ({
      id: `racer_${i}`,
      label: `Racer ${i}`,
      colorIndex: i,
    }));

    const events: RaceEvent[] = [
      { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
    ];

    let seq = 1;
    let t = 10;

    // Build a graph of 600 distinct nodes across 6 racers
    for (let i = 0; i < 100; i++) {
      for (let r = 0; r < 6; r++) {
        const from = i === 0 ? 'Start' : `Node_${r}_${i - 1}`;
        const to = `Node_${r}_${i}`;
        events.push({
          seq: seq++,
          t: (t += 10),
          type: 'StepTaken',
          racerId: `racer_${r}`,
          step: i + 1,
          from,
          to,
          index: 1,
          usage: ZERO_USAGE,
          latencyMs: 5,
        });
      }
    }

    const t0 = performance.now();
    const model = buildGraph(events);
    const modelBuildTime = performance.now() - t0;

    expect(model.nodes.size).toBeGreaterThanOrEqual(500);
    expect(modelBuildTime).toBeLessThan(100); // Very fast graph building

    const sim = new GraphSimulation(42);
    const tSync0 = performance.now();
    const synced = sim.sync(model);
    const syncTime = performance.now() - tSync0;

    expect(synced).toBe(true);
    expect(sim.nodes.length).toBeGreaterThanOrEqual(500);
    expect(syncTime).toBeLessThan(100);

    // Run 30 simulation ticks
    const tStep0 = performance.now();
    sim.step(30);
    const stepTime = performance.now() - tStep0;

    // 30 ticks of 600 nodes with d3-force should execute efficiently
    expect(stepTime).toBeLessThan(500);

    // Verify all node positions are finite numbers
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
});
