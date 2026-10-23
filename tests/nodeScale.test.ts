import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_SCALE, STORAGE_KEYS, clampNodeScale, formatNodeScale } from '../src/config';
import { LAYOUT, GraphSimulation } from '../src/graph/simulation';
import { buildGraph } from '../src/graph/graphModel';
import { ZERO_USAGE } from '../src/llm/types';
import type { Racer } from '../src/race/types';
import { getNodeScale, storeNodeScale } from '../src/ui/storage';
import { makeConfig } from './helpers/race';

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('node scale range', () => {
  it('spans 0.5x to 3x and defaults to 1x', () => {
    expect(NODE_SCALE.min).toBe(0.5);
    expect(NODE_SCALE.max).toBe(3);
    expect(NODE_SCALE.default).toBe(1);
  });

  it('clamps out-of-range values and replaces non-numbers with the default', () => {
    expect(clampNodeScale(0.1)).toBe(0.5);
    expect(clampNodeScale(10)).toBe(3);
    expect(clampNodeScale(1.7)).toBe(1.7);
    expect(clampNodeScale(Number.NaN)).toBe(1);
    expect(clampNodeScale(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('formats as one decimal place with an x', () => {
    expect(formatNodeScale(1)).toBe('1.0x');
    expect(formatNodeScale(0.5)).toBe('0.5x');
    expect(formatNodeScale(3)).toBe('3.0x');
    expect(formatNodeScale(99)).toBe('3.0x');
  });
});

describe('node scale storage', () => {
  let mockLocal: MockStorage;

  beforeEach(() => {
    mockLocal = new MockStorage();
    vi.stubGlobal('localStorage', mockLocal);
  });

  it('defaults to 1x when nothing is stored', () => {
    expect(getNodeScale()).toBe(1);
  });

  it('round-trips a saved value', () => {
    storeNodeScale(2.4);
    expect(mockLocal.getItem(STORAGE_KEYS.nodeScale)).toBe('2.4');
    expect(getNodeScale()).toBe(2.4);
  });

  it('clamps what it saves and what it reads back', () => {
    storeNodeScale(50);
    expect(getNodeScale()).toBe(3);
    mockLocal.setItem(STORAGE_KEYS.nodeScale, '0.01');
    expect(getNodeScale()).toBe(0.5);
  });

  it('ignores junk and empty values', () => {
    mockLocal.setItem(STORAGE_KEYS.nodeScale, 'banana');
    expect(getNodeScale()).toBe(1);
    mockLocal.setItem(STORAGE_KEYS.nodeScale, '');
    expect(getNodeScale()).toBe(1);
  });

  it('falls back to the default when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(getNodeScale()).toBe(1);
    expect(() => storeNodeScale(2)).not.toThrow();
  });
});

/** Two articles joined by one click: the simplest graph that has an edge. */
function twoNodeModel() {
  const racers: Racer[] = [{ id: 'm1', label: 'Model One', colorIndex: 0 }];
  return buildGraph([
    { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
    {
      seq: 1,
      t: 10,
      type: 'StepTaken',
      racerId: 'm1',
      step: 1,
      from: 'Start',
      to: 'Target',
      index: 1,
      usage: ZERO_USAGE,
      latencyMs: 10,
    },
  ]);
}

describe('GraphSimulation node scale', () => {
  /** How far apart the two articles settle at a given node scale. */
  function settledEdgeLength(scale: number): number {
    const sim = new GraphSimulation();
    sim.setNodeScale(scale);
    sim.sync(twoNodeModel());
    sim.step(5000);
    const [a, b] = sim.nodes;
    return Math.hypot(a!.x - b!.x, a!.y - b!.y);
  }

  it('makes edges longer and shorter in step with the scale', () => {
    const base = settledEdgeLength(1);
    expect(base).toBeGreaterThan(0);
    expect(settledEdgeLength(3) / base).toBeGreaterThan(2.7);
    expect(settledEdgeLength(3) / base).toBeLessThan(3.3);
    expect(settledEdgeLength(0.5) / base).toBeGreaterThan(0.45);
    expect(settledEdgeLength(0.5) / base).toBeLessThan(0.55);
  });

  it('stretches an existing layout straight away instead of waiting for it to settle', () => {
    const sim = new GraphSimulation();
    sim.sync(twoNodeModel());
    sim.step(5000);
    const before = sim.nodes.map((n) => ({ x: n.x, y: n.y }));
    sim.setNodeScale(2);
    sim.nodes.forEach((n, i) => {
      expect(n.x).toBeCloseTo(before[i]!.x * 2, 6);
      expect(n.y).toBeCloseTo(before[i]!.y * 2, 6);
    });
    expect(sim.active).toBe(true);
  });

  it('carries pinned (dragged) nodes along with the stretch', () => {
    const sim = new GraphSimulation();
    sim.sync(twoNodeModel());
    sim.pin('Start', 10, -20);
    sim.setNodeScale(3);
    const start = sim.nodeById('Start')!;
    expect(start.fx).toBe(30);
    expect(start.fy).toBe(-60);
  });

  it('does nothing when the scale has not changed', () => {
    const sim = new GraphSimulation();
    sim.sync(twoNodeModel());
    sim.step(5000);
    expect(sim.active).toBe(false);
    sim.setNodeScale(1);
    expect(sim.active).toBe(false);
  });

  it('gives new nodes a birth distance that matches the scale', () => {
    const sim = new GraphSimulation();
    sim.setNodeScale(3);
    sim.sync(twoNodeModel());
    // Start has no parent so it is born at the origin; the target is born far away, scaled.
    const target = sim.nodeById('Target')!;
    expect(Math.hypot(target.x, target.y)).toBeGreaterThan(LAYOUT.targetSpawnDistance * 2);
  });
});
