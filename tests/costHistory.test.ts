/** Real per-click cost history, checked against a real race export. */
import { describe, expect, it } from 'vitest';
import { choosePreset, type ModelInfo } from '../src/llm/models';
import {
  costSamples,
  mergeCostHistory,
  observedCostPerCall,
  sanitiseCostHistory,
} from '../src/race/costHistory';
import type { RaceEvent } from '../src/race/types';
import replayJson from './fixtures/replay-london-monster.json?raw';

const events = (JSON.parse(replayJson) as { events: RaceEvent[] }).events;
const LLAMA = 'meta-llama/llama-3.1-8b-instruct';
const NEMO = 'mistralai/mistral-nemo';

describe('cost history from a real race (London Monster -> John Howard)', () => {
  it('counts every paid call and sums its real cost', () => {
    const s = costSamples(events);
    expect(s.get(LLAMA)?.calls).toBe(30);
    expect(s.get(LLAMA)?.costUsd).toBeCloseTo(0.0111, 3);
    expect(s.get(NEMO)?.calls).toBe(5);
  });

  it('shows Llama 8B costing several times more per click than Mistral Nemo on this account', () => {
    const h = mergeCostHistory({}, events);
    const llama = observedCostPerCall(h, LLAMA)!;
    const nemo = observedCostPerCall(h, NEMO)!;
    expect(llama).toBeGreaterThan(nemo * 5);
    expect(h[LLAMA]?.races).toBe(1);
  });

  it('accumulates across races and ignores thin data', () => {
    const h = mergeCostHistory(mergeCostHistory({}, events), events);
    expect(h[LLAMA]).toMatchObject({ calls: 60, races: 2 });
    expect(observedCostPerCall({ a: { calls: 2, costUsd: 1, races: 1 } }, 'a')).toBeUndefined();
  });

  it('drops corrupted stored values', () => {
    expect(
      sanitiseCostHistory({ ok: { calls: 3, costUsd: 0.1, races: 1 }, bad: { calls: 'x' } }),
    ).toEqual({
      ok: { calls: 3, costUsd: 0.1, races: 1 },
    });
    expect(sanitiseCostHistory('nonsense')).toEqual({});
  });
});

describe('Fast & Cheap prefers what models really cost you', () => {
  const m = (id: string, prompt: number, completion: number): ModelInfo => ({
    id,
    name: id,
    supportsTools: true,
    promptPerMTok: prompt,
    completionPerMTok: completion,
    contextLength: 100_000,
    free: false,
  });
  const catalogue = [
    m(LLAMA, 0.02, 0.03),
    m(NEMO, 0.03, 0.05),
    m('a/alpha', 0.04, 0.1),
    m('b/beta', 0.05, 0.1),
    m('c/gamma', 0.06, 0.1),
  ];

  it('uses list prices when there is no history', () => {
    expect(choosePreset('fast', catalogue)[0]?.id).toBe(LLAMA);
  });

  it('drops a model that proved expensive on this account', () => {
    const h = mergeCostHistory({}, events);
    const ids = choosePreset('fast', catalogue, (id) => observedCostPerCall(h, id)).map(
      (x) => x.id,
    );
    expect(ids[0]).toBe(NEMO);
    expect(ids).not.toContain(LLAMA);
  });
});
