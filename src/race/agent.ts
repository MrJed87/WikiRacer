/**
 * One racer's loop: look at the page, ask the model, validate, move. Pure TypeScript with injected
 * provider/wiki/emit, so it runs identically in tests, the demo and the browser. No DOM.
 *
 * Fairness: every racer runs exactly this code with exactly the same `RaceConfig`.
 */
import {
  LlmError,
  ZERO_USAGE,
  addUsage,
  type ChooseLinkResult,
  type LlmProvider,
  type PageView,
  type Usage,
} from '../llm/types';
import { sleep } from '../util/retry';
import { canonicalTitle, sameTitle } from '../wiki/title';
import { WikiError, type PageData, type WikiSource } from '../wiki/types';
import { LoopTracker, loopHint } from './loopDetector';
import type { EventInput, RaceConfig, Racer } from './types';

export interface AgentDeps {
  racer: Racer;
  provider: LlmProvider;
  wiki: WikiSource;
  config: RaceConfig;
  emit: (event: EventInput) => void;
  /** Aborted when the race is stopped. */
  signal: AbortSignal;
  /** Resolves immediately unless the race is paused. */
  gate: () => Promise<void>;
  /** Lockstep: resolves when every racer still in the race is ready for the next click. */
  roundGate?: () => Promise<void>;
  /** Injectable so tests don't wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const INVALID_RETRY_HINT = (problem: string): string =>
  `Your previous reply was not valid: ${problem} Pick a link by its number from the list, or go back.`;

/**
 * Applies the race's link cap here, not only in the wiki source, so the configured cap is honoured
 * whatever source is plugged in (fairness: every racer sees the same capped list).
 */
function capLinks(page: PageData, linkCap: number): PageData {
  if (!(linkCap > 0) || page.links.length <= linkCap) return page;
  return { ...page, links: page.links.slice(0, linkCap), truncated: true };
}

function toView(page: PageData): PageView {
  return {
    title: page.title,
    summary: page.summary,
    links: page.links,
    totalLinks: page.totalLinks,
    truncated: page.truncated,
  };
}

/** Never throws: every outcome is reported through `emit`. */
export async function runAgent(deps: AgentDeps): Promise<void> {
  const { racer, provider, wiki, config, emit, signal } = deps;
  const wait = deps.sleep ?? sleep;
  const racerId = racer.id;

  const fail = (kind: 'wiki' | 'unexpected' | LlmError['kind'], message: string): void =>
    emit({ type: 'AgentFailed', racerId, kind, message });

  try {
    let page: PageData;
    try {
      page = capLinks(await wiki.getPage(config.start), config.linkCap);
    } catch (e) {
      if (signal.aborted) return;
      fail(
        'wiki',
        `Could not load the start page: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
      return;
    }
    if (signal.aborted) return;

    const loops = new LoopTracker(config.circlingThreshold);
    /** Link name -> page it actually opened (redirects), learned as this racer clicks. */
    const aliases = new Map<string, string>();
    loops.seed(page.title);
    /** Pages visited in order, shown to the model. */
    const trail: string[] = [page.title];
    /** Back-navigation stack. */
    const stack: string[] = [page.title];
    let usage: Usage = ZERO_USAGE;
    let steps = 0;
    let hint: string | undefined;

    if (sameTitle(page.title, config.target)) {
      emit({ type: 'Arrived', racerId, steps: 0, title: page.title });
      return;
    }

    for (;;) {
      await deps.gate();
      if (signal.aborted) return;
      if (deps.roundGate) {
        await deps.roundGate();
        if (signal.aborted) return;
        // A pause pressed while waiting for the round still applies before the click.
        await deps.gate();
        if (signal.aborted) return;
      }

      if (steps >= config.maxSteps) {
        emit({ type: 'GaveUp', racerId, steps });
        return;
      }
      if (usage.costUsd >= config.budgetUsd) {
        emit({ type: 'BudgetExceeded', racerId, limit: 'usd' });
        return;
      }
      if (usage.totalTokens >= config.budgetTokens) {
        emit({ type: 'BudgetExceeded', racerId, limit: 'tokens' });
        return;
      }

      // Visit cap: pages this racer has already visited the maximum number of times are no
      // longer offered, and `back` can't return to one either. Same rule for every racer.
      const cap = config.maxVisitsPerPage;
      // Links can name a redirect ("Catholicism") rather than the page it opens ("Catholic
      // Church"), so known aliases are resolved before counting visits.
      const exhausted = (title: string): boolean =>
        cap !== undefined &&
        cap > 0 &&
        !sameTitle(title, config.target) &&
        loops.visitsTo(aliases.get(canonicalTitle(title)) ?? title) >= cap;
      const view = toView(page);
      const blocked = view.links.filter(exhausted);
      if (blocked.length) view.links = view.links.filter((t) => !exhausted(t));
      const previous = stack[stack.length - 2];
      const canGoBack = previous !== undefined && !exhausted(previous);
      if (view.links.length === 0 && !canGoBack) {
        emit({ type: 'Stuck', racerId, title: page.title });
        return;
      }
      const capNote =
        blocked.length > 0
          ? `Pages you have already visited ${cap} times are no longer offered: ${blocked
              .slice(0, 5)
              .map((t) => `"${t}"`)
              .join(', ')}${blocked.length > 5 ? ` and ${blocked.length - 5} more` : ''}.`
          : undefined;

      // Ask, allowing one correction round for an invalid reply.
      let result: ChooseLinkResult | undefined;
      let askHint = [hint, capNote].filter(Boolean).join(' ') || undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: ChooseLinkResult;
        try {
          res = await provider.chooseLink({
            model: racer.id,
            target: config.target,
            targetSummary: config.targetSummary,
            current: view,
            // A copy: `trail` keeps growing, and requests may be retained by callers (logs, tests).
            path: [...trail],
            step: steps + 1,
            maxSteps: config.maxSteps,
            canGoBack,
            temperature: config.temperature,
            ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
            ...(config.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
            signal,
            ...(askHint !== undefined ? { hint: askHint } : {}),
          });
        } catch (e) {
          if (signal.aborted) return;
          if (e instanceof LlmError) {
            if (e.kind === 'aborted') return;
            fail(e.kind, e.message);
          } else {
            fail('unexpected', e instanceof Error ? e.message : 'Unexpected error');
          }
          return;
        }
        if (signal.aborted) return;
        usage = addUsage(usage, res.usage);

        if (res.choice.kind !== 'invalid') {
          result = res;
          break;
        }
        const willRetry = attempt === 0;
        if (!willRetry) steps++;
        emit({
          type: 'InvalidChoice',
          racerId,
          step: steps,
          at: page.title,
          problem: res.choice.problem,
          raw: res.choice.raw,
          willRetry,
          wasted: !willRetry,
          usage: res.usage,
          latencyMs: res.latencyMs,
        });
        askHint = [INVALID_RETRY_HINT(res.choice.problem), capNote].filter(Boolean).join(' ');
      }

      if (result === undefined) {
        // Two invalid replies in a row: the click was spent above. Stay here and ask afresh.
        hint = undefined;
      } else {
        const { choice } = result;
        if (choice.kind === 'back') {
          steps++;
          stack.pop();
          const previous = stack[stack.length - 1];
          if (previous === undefined) {
            fail('unexpected', 'Back navigation ran out of history');
            return;
          }
          try {
            page = capLinks(await wiki.getPage(previous), config.linkCap);
          } catch (e) {
            if (signal.aborted) return;
            fail(
              'wiki',
              `Could not reload “${previous}”: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
            return;
          }
          if (signal.aborted) return;
          const from = trail[trail.length - 1] ?? previous;
          trail.push(page.title);
          // Going back is deliberate exploration, not circling, so it doesn't count as a visit.
          hint = undefined;
          emit({
            type: 'WentBack',
            racerId,
            step: steps,
            from,
            to: page.title,
            usage: result.usage,
            latencyMs: result.latencyMs,
            ...(choice.reason !== undefined ? { reason: choice.reason } : {}),
          });
        } else if (choice.kind === 'link') {
          steps++;
          const from = page.title;
          let next: PageData;
          try {
            next = capLinks(await wiki.getPage(choice.title), config.linkCap);
          } catch (e) {
            if (signal.aborted) return;
            if (e instanceof WikiError && e.kind === 'not-found') {
              // The link was offered but the page can't be opened: the click is spent, the model stays put.
              emit({
                type: 'InvalidChoice',
                racerId,
                step: steps,
                at: from,
                problem: `The page “${choice.title}” could not be opened.`,
                raw: '',
                willRetry: false,
                wasted: true,
                usage: result.usage,
                latencyMs: result.latencyMs,
              });
              hint = `The page "${choice.title}" could not be opened. Choose a different link.`;
              await pause(config.stepDelayMs, wait, signal);
              continue;
            }
            fail(
              'wiki',
              `Could not load “${choice.title}”: ${e instanceof Error ? e.message : 'unknown error'}`,
            );
            return;
          }
          if (signal.aborted) return;
          if (!sameTitle(next.title, choice.title)) {
            aliases.set(canonicalTitle(choice.title), next.title);
          }
          if (exhausted(next.title)) {
            // A redirect we hadn't seen led to a used-up page. The model couldn't have known, so
            // the move is cancelled without costing a click, and the alias is now blocked too.
            steps--;
            const problem = `“${choice.title}” leads to “${next.title}”, which you have already visited ${cap} times, the maximum.`;
            emit({
              type: 'InvalidChoice',
              racerId,
              step: steps,
              at: from,
              problem,
              raw: '',
              willRetry: true,
              wasted: false,
              usage: result.usage,
              latencyMs: result.latencyMs,
            });
            hint = `${problem.replace(/[“”]/g, '"')} Choose a different link.`;
            continue;
          }
          page = next;
          stack.push(page.title);
          trail.push(page.title);
          const visit = loops.visit(page.title);
          emit({
            type: 'StepTaken',
            racerId,
            step: steps,
            from,
            to: page.title,
            index: choice.index,
            usage: result.usage,
            latencyMs: result.latencyMs,
            ...(choice.reason !== undefined ? { reason: choice.reason } : {}),
          });
          if (visit.revisited)
            emit({ type: 'Revisited', racerId, title: page.title, visits: visit.visits });
          if (visit.startedCircling)
            emit({ type: 'Circling', racerId, title: page.title, visits: visit.visits });
          hint = loopHint(page.title, visit.visits, config.maxVisitsPerPage);

          if (canonicalTitle(page.title) === canonicalTitle(config.target)) {
            emit({ type: 'Arrived', racerId, steps, title: page.title });
            return;
          }
        }
      }

      await pause(config.stepDelayMs, wait, signal);
      if (signal.aborted) return;
    }
  } catch (e) {
    // Last line of defence: one racer's bug must never take the others down.
    if (!signal.aborted) fail('unexpected', e instanceof Error ? e.message : 'Unexpected error');
  }
}

async function pause(
  ms: number,
  wait: NonNullable<AgentDeps['sleep']>,
  signal: AbortSignal,
): Promise<void> {
  if (ms <= 0) return;
  try {
    await wait(ms, signal);
  } catch {
    // Aborted while waiting: the loop's next signal check ends the agent.
  }
}
