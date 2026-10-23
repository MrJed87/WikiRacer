import { LlmError } from '../../src/llm/types';
import { FakeWiki, type FakeWikiOptions } from '../../src/mock/fakeWiki';
import { MockProvider, type Decider, type MockProviderOptions } from '../../src/mock/mockProvider';
import { RACE_DEFAULTS } from '../../src/config';
import { PROMPT_VERSION } from '../../src/llm/prompt';
import { RaceManager, type Entrant } from '../../src/race/raceManager';
import { RaceStore } from '../../src/race/store';
import type { RaceConfig, RaceEvent } from '../../src/race/types';

/**
 *  Start -> A, B, C
 *  A -> D, Start
 *  B -> Target
 *  C -> A
 *  D -> A, C
 */
export const GRAPH = {
  Start: ['A', 'B', 'C'],
  A: ['D', 'Start'],
  B: ['Target'],
  C: ['A'],
  D: ['A', 'C'],
  Target: [],
};

export const makeWiki = (opts: FakeWikiOptions = {}, graph: Record<string, string[]> = GRAPH) =>
  new FakeWiki(graph, opts);

export const makeConfig = (over: Partial<RaceConfig> = {}): RaceConfig => ({
  start: 'Start',
  target: 'Target',
  targetSummary: 'The goal.',
  maxSteps: 10,
  linkCap: 150,
  temperature: 0.2,
  circlingThreshold: 3,
  budgetUsd: 100,
  budgetTokens: 10_000_000,
  stepDelayMs: 0,
  stopOnFirstArrival: false,
  promptVersion: PROMPT_VERSION,
  ...over,
});

export const entrant = (
  id: string,
  decide: Decider,
  opts: MockProviderOptions = {},
): Entrant & { provider: MockProvider } => ({
  racer: { id, label: id, colorIndex: 0 },
  provider: new MockProvider(decide, opts),
});

/** Deterministic clock: +10ms per read. */
export const tickingStore = (): RaceStore => {
  let now = 1_000;
  return new RaceStore({ now: () => (now += 10) });
};

export interface RunOptions {
  entrants: Entrant[];
  config?: Partial<RaceConfig>;
  wiki?: FakeWiki;
}

export async function runRace(opts: RunOptions) {
  const manager = new RaceManager({
    entrants: opts.entrants,
    wiki: opts.wiki ?? makeWiki(),
    config: makeConfig(opts.config),
    store: tickingStore(),
    sleep: async () => {},
  });
  await manager.start();
  return {
    manager,
    store: manager.store,
    state: manager.store.state,
    events: manager.store.events,
  };
}

export const types = (events: readonly RaceEvent[], racerId?: string): string[] =>
  events
    .filter((e) => racerId === undefined || !('racerId' in e) || e.racerId === racerId)
    .map((e) => e.type);

export const authError = new LlmError('auth', 'OpenRouter rejected the API key', { status: 401 });

export { RACE_DEFAULTS };
