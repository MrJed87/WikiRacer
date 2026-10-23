/**
 * A scriptable `LlmProvider` for tests and the offline demo. Decisions are turned into raw replies and
 * pushed through the real `parseChoice`, so mock racers exercise the same validation as real ones.
 * No DOM.
 */
import { parseChoice } from '../llm/parseChoice';
import { buildMessages } from '../llm/prompt';
import {
  LlmError,
  type ChooseLinkRequest,
  type ChooseLinkResult,
  type LlmProvider,
  type Usage,
} from '../llm/types';
import { sleep } from '../util/retry';

export type MockDecision =
  | { link: string; reason?: string }
  | { index: number; reason?: string }
  | { back: true; reason?: string }
  /** A reply that is not a valid choice (raw text from the "model"). */
  | { garbage: string }
  | { error: LlmError };

/** `call` counts this provider's calls from 0 (including retries after invalid replies). */
export type Decider = (request: ChooseLinkRequest, call: number) => MockDecision;

export interface MockProviderOptions {
  /** Simulated thinking time in ms. */
  latencyMs?: number;
  /** USD per million tokens, to give the scoreboard a cost to show. */
  usdPerMTok?: number;
  completionTokens?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class MockProvider implements LlmProvider {
  readonly requests: ChooseLinkRequest[] = [];
  private calls = 0;

  constructor(
    private readonly decide: Decider,
    private readonly opts: MockProviderOptions = {},
  ) {}

  async chooseLink(request: ChooseLinkRequest): Promise<ChooseLinkResult> {
    this.requests.push(request);
    const call = this.calls++;
    const started = Date.now();
    if (request.signal?.aborted) throw new LlmError('aborted', 'Cancelled');
    if (this.opts.latencyMs) {
      try {
        await (this.opts.sleep ?? sleep)(this.opts.latencyMs, request.signal);
      } catch {
        throw new LlmError('aborted', 'Cancelled');
      }
    }

    const decision = this.decide(request, call);
    if ('error' in decision) throw decision.error;

    const promptChars = buildMessages(request).reduce((n, m) => n + m.content.length, 0);
    const completionTokens = this.opts.completionTokens ?? 24;
    const promptTokens = Math.ceil(promptChars / 4);
    const usage: Usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: ((promptTokens + completionTokens) / 1_000_000) * (this.opts.usdPerMTok ?? 1),
    };

    let toolArguments: string | undefined;
    let content: string | undefined;
    if ('garbage' in decision) content = decision.garbage;
    else if ('back' in decision)
      toolArguments = JSON.stringify({ back: true, reason: decision.reason });
    else if ('index' in decision)
      toolArguments = JSON.stringify({ index: decision.index, reason: decision.reason });
    else toolArguments = JSON.stringify({ title: decision.link, reason: decision.reason });

    const choice = parseChoice(
      { toolArguments, content },
      request.current.links,
      request.canGoBack,
    );
    return { choice, usage, latencyMs: Date.now() - started };
  }
}
