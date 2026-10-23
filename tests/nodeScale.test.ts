import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_SCALE, STORAGE_KEYS, clampNodeScale, formatNodeScale } from '../src/config';
import { LAYOUT, GraphSimulation } from '../src/graph/simulation';
import { getNodeScale, storeNodeScale } from '../src/ui/storage';

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

describe('GraphSimulation node scale', () => {
  /** A fresh d3 simulation starts hot; let it cool so reheating is observable. */
  function settledSim(): GraphSimulation {
    const sim = new GraphSimulation();
    sim.step(1000);
    expect(sim.active).toBe(false);
    return sim;
  }

  it('re-flows the layout when bigger nodes need more room', () => {
    const sim = settledSim();
    sim.setNodeScale(2);
    expect(sim.alpha).toBeGreaterThanOrEqual(LAYOUT.alphaOnChange);
  });

  it('leaves the layout alone for shrinking, or for the same spacing again', () => {
    const sim = settledSim();
    sim.setNodeScale(0.5);
    expect(sim.active).toBe(false);

    sim.setNodeScale(2);
    sim.step(1000);
    expect(sim.active).toBe(false);
    sim.setNodeScale(2);
    expect(sim.active).toBe(false);
  });
});
