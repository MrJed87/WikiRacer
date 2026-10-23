/** Intelligence filter and alias handling, using real OpenRouter catalogue entries. */
import { describe, expect, it } from 'vitest';
import {
  choosePreset,
  enrichFromCatalogue,
  filterByIntelligence,
  normaliseModels,
  pickDistinctFamilies,
  searchModels,
  sortModels,
} from '../src/llm/models';
import raw from './fixtures/models-2026-10.json?raw';

const models = normaliseModels(JSON.parse(raw));
const byId = (id: string) => models.find((m) => m.id === id)!;

describe('intelligence scores from the catalogue (captured 2026-10-22)', () => {
  it('reads the Artificial Analysis Intelligence Index', () => {
    expect(byId('meta-llama/llama-3.1-8b-instruct').intelligence).toBe(6.9);
    expect(byId('inclusionai/ling-3.0-flash').intelligence).toBe(20.1);
    expect(byId('z-ai/glm-5.3-flash').intelligence).toBe(41.8);
  });

  it('gives an alias its target score and leaves unscored models null', () => {
    expect(byId('~z-ai/glm-flash-latest').aliasOf).toBe('z-ai/glm-5.3-flash');
    expect(byId('~z-ai/glm-flash-latest').intelligence).toBe(41.8);
    expect(byId('mistralai/mistral-nemo').intelligence).toBeNull();
  });

  it('treats an alias and its target as one family', () => {
    const picked = pickDistinctFamilies([
      byId('~z-ai/glm-flash-latest'),
      byId('z-ai/glm-5.3-flash'),
    ]);
    expect(picked).toHaveLength(1);
  });
});

describe('minimum intelligence', () => {
  it('keeps models at or above the minimum and hides unscored ones', () => {
    const ids = filterByIntelligence(models, 20).map((m) => m.id);
    expect(ids).toContain('inclusionai/ling-3.0-flash');
    expect(ids).not.toContain('meta-llama/llama-3.1-8b-instruct');
    expect(ids).not.toContain('mistralai/mistral-nemo');
  });

  it('no minimum (null, 0 or blank) means no filtering', () => {
    expect(filterByIntelligence(models, null)).toHaveLength(models.length);
    expect(filterByIntelligence(models, 0)).toHaveLength(models.length);
    expect(filterByIntelligence(models, NaN)).toHaveLength(models.length);
  });

  it('a filtered Fast & Cheap preset no longer picks Llama 3.1 8B', () => {
    expect(choosePreset('fast', models).map((m) => m.id)).toContain(
      'meta-llama/llama-3.1-8b-instruct',
    );
    const smart = choosePreset('fast', filterByIntelligence(models, 15)).map((m) => m.id);
    expect(smart).not.toContain('meta-llama/llama-3.1-8b-instruct');
    expect(smart.length).toBeGreaterThanOrEqual(2);
  });
});

describe('account list without scores (GET /models/user has no benchmarks)', () => {
  const stripped = JSON.parse(raw) as { data: Array<Record<string, unknown>> };
  for (const m of stripped.data) {
    delete m['benchmarks'];
    delete m['alias_target'];
  }
  const account = normaliseModels(stripped);

  it('reproduces the bug: no scores, so any minimum hides everything', () => {
    expect(account.every((m) => m.intelligence === null)).toBe(true);
    expect(filterByIntelligence(account, 2)).toHaveLength(0);
  });

  it('enriching from the public catalogue restores scores and alias targets', () => {
    const fixed = enrichFromCatalogue(account, models);
    const get = (id: string) => fixed.find((m) => m.id === id)!;
    expect(get('z-ai/glm-5.3-flash').intelligence).toBe(41.8);
    expect(get('~z-ai/glm-flash-latest')).toMatchObject({
      intelligence: 41.8,
      aliasOf: 'z-ai/glm-5.3-flash',
    });
    expect(filterByIntelligence(fixed, 2).length).toBeGreaterThan(3);
  });

  it('keeps the account list as the source of truth for which models exist', () => {
    const fixed = enrichFromCatalogue(account.slice(0, 2), models);
    expect(fixed.map((m) => m.id)).toEqual(account.slice(0, 2).map((m) => m.id));
  });
});

describe('model list sorting', () => {
  it('intelligence: highest first, unscored last', () => {
    const ids = sortModels(models, 'intelligence').map((m) => m.id);
    expect(ids[0]).toMatch(/glm/);
    expect(ids.at(-1)).toBe('mistralai/mistral-nemo');
  });

  it('price: cheapest first, using real cost on this browser when known', () => {
    const cheapest = sortModels(models, 'price')[0]!.id;
    const withHistory = sortModels(models, 'price', (id) =>
      id === 'z-ai/glm-5.3-flash' ? 0 : undefined,
    );
    expect(withHistory[0]!.id).toBe('z-ai/glm-5.3-flash');
    expect(cheapest).not.toBe('z-ai/glm-5.3-flash');
  });

  it('search has no hidden cap when asked for everything', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...models[0]!,
      id: `x/m${i}`,
      name: `M${i}`,
    }));
    expect(searchModels(many, '', Infinity)).toHaveLength(120);
  });
});
