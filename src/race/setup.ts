/** Builds the one `RaceConfig` every racer shares (fairness). No DOM. */
import { RACE_DEFAULTS } from '../config';
import { PROMPT_VERSION } from '../llm/prompt';
import { articleTitleOrRaw } from '../wiki/title';
import type { WikiSource } from '../wiki/types';
import type { RaceConfig } from './types';

export type RaceOverrides = Partial<
  Pick<
    RaceConfig,
    | 'maxSteps'
    | 'linkCap'
    | 'temperature'
    | 'circlingThreshold'
    | 'maxVisitsPerPage'
    | 'reasoningEffort'
    | 'maxOutputTokens'
    | 'budgetUsd'
    | 'budgetTokens'
    | 'stepDelayMs'
    | 'stopOnFirstArrival'
  >
>;

export interface RaceSetup {
  /** Start title (will be resolved and canonicalised). */
  start: string;
  /** Target title (will be resolved and canonicalised). */
  target: string;
  overrides?: RaceOverrides;
}

/**
 * Resolves start and target titles (following any redirects) and fetches the target's lead text
 * (shared cache) so every model knows what it is aiming at and all racers share the canonical start.
 */
export async function buildRaceConfig(wiki: WikiSource, setup: RaceSetup): Promise<RaceConfig> {
  // Share links and replays can carry pasted URLs, so normalise them here too.
  let start = articleTitleOrRaw(setup.start);
  try {
    start = (await wiki.getPage(start)).title;
  } catch {
    // If start page fails to load here, agent.ts will catch and report it as a wiki error.
  }

  let target = articleTitleOrRaw(setup.target);
  let targetSummary = '';
  try {
    const targetPage = await wiki.getPage(target);
    target = targetPage.title;
    targetSummary = targetPage.summary;
  } catch {
    // The summary is a nicety; the race can run without it.
  }

  return {
    start,
    target,
    targetSummary,
    maxSteps: RACE_DEFAULTS.maxSteps,
    linkCap: RACE_DEFAULTS.linkCap,
    temperature: RACE_DEFAULTS.temperature,
    circlingThreshold: RACE_DEFAULTS.circlingThreshold,
    maxVisitsPerPage: RACE_DEFAULTS.maxVisitsPerPage,
    reasoningEffort: RACE_DEFAULTS.reasoningEffort,
    maxOutputTokens: RACE_DEFAULTS.maxOutputTokens,
    budgetUsd: RACE_DEFAULTS.budgetUsd,
    budgetTokens: RACE_DEFAULTS.budgetTokens,
    stepDelayMs: RACE_DEFAULTS.stepDelayMs,
    stopOnFirstArrival: RACE_DEFAULTS.stopOnFirstArrival,
    lockstep: RACE_DEFAULTS.lockstep,
    promptVersion: PROMPT_VERSION,
    ...setup.overrides,
  };
}
