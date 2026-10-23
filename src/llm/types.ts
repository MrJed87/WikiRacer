/** Shared LLM-layer types. No DOM. */

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD as reported by OpenRouter (`usage.cost`); 0 when the provider doesn't report it. */
  costUsd: number;
}

export const ZERO_USAGE: Usage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/** The page a model is looking at. Links are canonical titles; the prompt numbers them from 1. */
export interface PageView {
  title: string;
  summary: string;
  links: string[];
  /** Distinct links on the real page before the cap. */
  totalLinks: number;
  truncated: boolean;
}

export interface ChooseLinkRequest {
  model: string;
  target: string;
  /** Lead text of the target so every model knows what it is aiming at. */
  targetSummary: string;
  current: PageView;
  /** Titles visited so far, oldest first, ending with `current.title`. */
  path: string[];
  /** 1-based number of the click about to be made. */
  step: number;
  maxSteps: number;
  canGoBack: boolean;
  /** Neutral nudge from the engine, e.g. a loop notice or a correction after an invalid reply. */
  hint?: string;
  temperature: number;
  /** Thinking effort for reasoning models (ignored by OpenRouter for models that don't reason). */
  reasoningEffort?: ReasoningEffort;
  /** Cap on reply tokens, thinking included on most providers. */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** OpenRouter's reasoning effort levels (a share of the reply-token cap on most providers). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
];

/** What a model decided, after validation against the offered links. Never trust raw output. */
export type ModelChoice =
  | {
      kind: 'link';
      title: string;
      /** 1-based index in the offered list. */ index: number;
      reason?: string;
    }
  | { kind: 'back'; reason?: string }
  | { kind: 'invalid'; problem: string; raw: string };

export interface ChooseLinkResult {
  choice: ModelChoice;
  usage: Usage;
  latencyMs: number;
}

export interface LlmProvider {
  chooseLink(request: ChooseLinkRequest): Promise<ChooseLinkResult>;
}

export type LlmErrorKind =
  | 'auth' // 401/403: bad key
  | 'payment' // 402: out of credits
  | 'model-unavailable' // 404: model gone or no provider
  | 'bad-request' // 400: we sent something the model can't take
  | 'rate-limit' // 429
  | 'server' // 5xx
  | 'network'
  | 'timeout'
  | 'bad-response'
  | 'aborted';

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | undefined;
  /** Server-provided delay (ms) from Retry-After, if any. */
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }

  /** Transient: worth a bounded retry. */
  get retryable(): boolean {
    return (
      this.kind === 'rate-limit' ||
      this.kind === 'server' ||
      this.kind === 'network' ||
      this.kind === 'timeout'
    );
  }

  /** Stops that agent for good (401 and 402 stop the agent with a clear message). */
  get fatal(): boolean {
    return (
      this.kind === 'auth' ||
      this.kind === 'payment' ||
      this.kind === 'model-unavailable' ||
      this.kind === 'bad-request'
    );
  }
}
