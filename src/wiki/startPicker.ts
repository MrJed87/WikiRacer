/** Picks an obscure, well-connected start article, and validates the user's target. No DOM. */
import { WIKI } from '../config';
import type { WikipediaClient } from './client';
import { canonicalTitle, isMainNamespaceTitle, parseArticleInput } from './title';
import { WikiError } from './types';

export interface StartPickerOptions {
  /** The race target; never chosen as the start. */
  target: string;
  maxAvgDailyViews?: number;
  minOutgoingLinks?: number;
  minIncomingLinks?: number;
  /** Max random batches to try. */
  maxAttempts?: number;
  /** Candidates per random batch. */
  batchSize?: number;
  signal?: AbortSignal;
}

export interface StartPick {
  title: string;
  avgDailyViews: number;
  outgoingLinks: number;
  incomingLinks: number;
  /** Random batches consumed. */
  attempts: number;
}

/** Title-level screening: lists and disambiguation pages make for dull or dead-end starts. */
export function looksLikeBadStart(title: string): boolean {
  return (
    !isMainNamespaceTitle(title) ||
    /^(List|Lists|Index|Outline) of /i.test(title) ||
    /\((disambiguation|surname|given name)\)$/i.test(title)
  );
}

export async function pickObscureStart(
  client: Pick<
    WikipediaClient,
    'randomTitles' | 'averageDailyViews' | 'getPage' | 'incomingLinkCount'
  >,
  opts: StartPickerOptions,
): Promise<StartPick> {
  const cfg = WIKI.startPicker;
  const maxViews = opts.maxAvgDailyViews ?? cfg.maxAvgDailyViews;
  const minOut = opts.minOutgoingLinks ?? cfg.minOutgoingLinks;
  const minIn = opts.minIncomingLinks ?? cfg.minIncomingLinks;
  const maxAttempts = opts.maxAttempts ?? cfg.maxAttempts;
  const batch = opts.batchSize ?? 10;
  const target = canonicalTitle(opts.target);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new WikiError('network', 'Start selection cancelled');
    const random = await client.randomTitles(batch);
    const candidates = random.filter((t) => t !== target && !looksLikeBadStart(t));
    if (candidates.length === 0) continue;
    const views = await client.averageDailyViews(candidates);

    for (const title of candidates) {
      const avg = views.get(title);
      if (avg === undefined || avg > maxViews) continue;
      let page;
      try {
        page = await client.getPage(title);
      } catch (e) {
        if (e instanceof WikiError && e.kind === 'not-found') continue;
        throw e;
      }
      if (page.isDisambiguation || page.title === target || page.totalLinks < minOut) continue;
      const incoming = await client.incomingLinkCount(page.title, minIn);
      if (incoming < minIn) continue;
      return {
        title: page.title,
        avgDailyViews: avg,
        outgoingLinks: page.totalLinks,
        incomingLinks: incoming,
        attempts: attempt,
      };
    }
  }
  throw new WikiError(
    'no-start',
    `Could not find a suitable obscure start article after ${maxAttempts} attempts`,
  );
}

export type TargetValidation =
  { ok: true; title: string; incomingLinks: number } | { ok: false; reason: string };

/** The target must exist, be an article, and be reachable (have at least one incoming link). */
export async function validateTarget(
  client: Pick<WikipediaClient, 'resolveTitle' | 'incomingLinkCount'>,
  input: string,
): Promise<TargetValidation> {
  const parsed = parseArticleInput(input);
  if (!parsed.ok) return parsed;
  const wanted = parsed.title;
  if (!isMainNamespaceTitle(wanted)) {
    return {
      ok: false,
      reason: 'Target must be a regular article (no "Category:", "Help:" etc.).',
    };
  }
  const resolved = await client.resolveTitle(wanted);
  if (!resolved.exists) return { ok: false, reason: `No Wikipedia article called “${wanted}”.` };
  if (!isMainNamespaceTitle(resolved.title)) {
    return { ok: false, reason: `“${wanted}” redirects outside the article namespace.` };
  }
  const incoming = await client.incomingLinkCount(resolved.title, 5);
  if (incoming === 0) {
    return { ok: false, reason: `Nothing links to “${resolved.title}”, so it can't be reached.` };
  }
  return { ok: true, title: resolved.title, incomingLinks: incoming };
}

export type StartValidation =
  { ok: true; title: string; outgoingLinks: number } | { ok: false; reason: string };

/**
 * Checks a custom start before the race, so a typo fails here with a message instead of failing
 * every racer on its first page load.
 */
export async function validateStart(
  client: Pick<WikipediaClient, 'resolveTitle' | 'getPage'>,
  input: string,
): Promise<StartValidation> {
  const parsed = parseArticleInput(input);
  if (!parsed.ok) return parsed;
  const wanted = parsed.title;
  if (!isMainNamespaceTitle(wanted)) {
    return { ok: false, reason: 'Start must be a regular article (no "Category:", "Help:" etc.).' };
  }
  const resolved = await client.resolveTitle(wanted);
  if (!resolved.exists) return { ok: false, reason: `No Wikipedia article called “${wanted}”.` };
  if (!isMainNamespaceTitle(resolved.title)) {
    return { ok: false, reason: `“${wanted}” redirects outside the article namespace.` };
  }
  const page = await client.getPage(resolved.title);
  if (page.links.length === 0) {
    return { ok: false, reason: `“${page.title}” has no article links to follow.` };
  }
  return { ok: true, title: page.title, outgoingLinks: page.totalLinks };
}
