/**
 * The only door to OpenRouter: all model calls go through this class so tests can swap in a fake
 * `fetch` and never hit the network. Injectable `fetch`, timeout + abort, bounded backoff,
 * `choose_link` tool call with a JSON-in-content fallback, and usage/cost capture. No DOM.
 *
 * The API key lives only in this object's private field and the Authorization header. It is never
 * logged, never put in a URL and never included in error messages.
 */
import { OPENROUTER } from '../config';
import { withRetry, type RetryOptions } from '../util/retry';
import { TOOL_NAME, parseChoice } from './parseChoice';
import { buildMessages } from './prompt';
import {
  LlmError,
  type ChooseLinkRequest,
  type ChooseLinkResult,
  type LlmProvider,
  type Usage,
} from './types';

export type LlmFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterOptions {
  apiKey: string;
  fetch?: LlmFetch;
  baseUrl?: string;
  /** Sent as HTTP-Referer for OpenRouter attribution; the UI passes the page origin. */
  referer?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  retry?: Partial<Omit<RetryOptions, 'signal'>>;
  /**
   * Model ids known not to support tools. For these, the request omits `tools` and relies on the
   * JSON fallback in the prompt. The request is otherwise identical.
   */
  noToolsModels?: Iterable<string>;
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function parseUsage(raw: unknown): Usage {
  if (!isRecord(raw)) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
  const promptTokens = num(raw['prompt_tokens']);
  const completionTokens = num(raw['completion_tokens']);
  return {
    promptTokens,
    completionTokens,
    totalTokens: num(raw['total_tokens']) || promptTokens + completionTokens,
    costUsd: num(raw['cost']),
  };
}

const TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Choose the next Wikipedia link to click, or go back to the previous page.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '1-based number of the chosen link in the list.' },
        back: {
          type: 'boolean',
          description: 'Set true to return to the previous page instead of choosing a link.',
        },
        reason: { type: 'string', description: 'One short sentence explaining the choice.' },
      },
      additionalProperties: false,
    },
  },
} as const;

/** Error text from the body, truncated. Bodies never contain our key, but keep it short anyway. */
function bodyMessage(body: unknown): string {
  if (isRecord(body)) {
    const err = body['error'];
    if (isRecord(err) && typeof err['message'] === 'string') return err['message'].slice(0, 200);
    if (typeof body['message'] === 'string') return body['message'].slice(0, 200);
  }
  return '';
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (h === null) return undefined;
  const seconds = Number(h);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export function errorFromStatus(status: number, body: unknown, retryAfter?: number): LlmError {
  const detail = bodyMessage(body);
  const withDetail = (base: string): string => (detail ? `${base}: ${detail}` : base);
  const opts = retryAfter === undefined ? { status } : { status, retryAfterMs: retryAfter };
  if (status === 401 || status === 403) {
    return new LlmError('auth', withDetail('OpenRouter rejected the API key'), opts);
  }
  if (status === 402) return new LlmError('payment', withDetail('Out of OpenRouter credits'), opts);
  if (status === 404)
    return new LlmError('model-unavailable', withDetail('Model unavailable'), opts);
  if (status === 408) return new LlmError('timeout', withDetail('OpenRouter timed out'), opts);
  if (status === 429) return new LlmError('rate-limit', withDetail('Rate limited'), opts);
  if (status >= 500)
    return new LlmError('server', withDetail(`OpenRouter error (HTTP ${status})`), opts);
  return new LlmError('bad-request', withDetail(`Request rejected (HTTP ${status})`), opts);
}

export class OpenRouterClient implements LlmProvider {
  readonly #apiKey: string;
  private readonly fetchFn: LlmFetch;
  private readonly baseUrl: string;
  private readonly referer: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly retry: Omit<RetryOptions, 'signal'>;
  private readonly noTools: Set<string>;

  constructor(opts: OpenRouterOptions) {
    this.#apiKey = opts.apiKey;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = opts.baseUrl ?? OPENROUTER.baseUrl;
    this.referer = opts.referer;
    this.timeoutMs = opts.timeoutMs ?? OPENROUTER.requestTimeoutMs;
    this.maxOutputTokens = opts.maxOutputTokens ?? OPENROUTER.maxOutputTokens;
    this.noTools = new Set(opts.noToolsModels ?? []);
    this.retry = {
      retries: opts.retry?.retries ?? OPENROUTER.maxRetries,
      baseMs: opts.retry?.baseMs ?? OPENROUTER.backoffBaseMs,
      maxMs: opts.retry?.maxMs ?? OPENROUTER.backoffMaxMs,
      ...(opts.retry?.sleep ? { sleep: opts.retry.sleep } : {}),
    };
  }

  /** Never serialise the key: JSON.stringify(client) and console.log(client) show nothing sensitive. */
  toJSON(): Record<string, never> {
    return {};
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': OPENROUTER.appTitle,
    };
    if (this.referer) h['HTTP-Referer'] = this.referer;
    return h;
  }

  /** One HTTP request with timeout; maps every failure to an `LlmError`. */
  private async request(url: string, init: RequestInit, external?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = external ? AbortSignal.any([external, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(url, { ...init, signal });
    } catch (e) {
      if (external?.aborted) throw new LlmError('aborted', 'Cancelled');
      if (timeout.aborted)
        throw new LlmError('timeout', `No response within ${Math.round(this.timeoutMs / 1000)}s`);
      throw new LlmError(
        'network',
        `Could not reach OpenRouter${e instanceof Error ? `: ${e.message}` : ''}`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) throw errorFromStatus(res.status, body, retryAfterMs(res));
    return body;
  }

  private send(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    return withRetry(
      () => this.request(url, init, signal),
      (e) => e instanceof LlmError && e.retryable,
      signal ? { ...this.retry, signal } : this.retry,
      (e) => (e instanceof LlmError ? e.retryAfterMs : undefined),
    );
  }

  async chooseLink(req: ChooseLinkRequest): Promise<ChooseLinkResult> {
    const started = Date.now();
    const useTools = !this.noTools.has(req.model);
    const body = (withTools: boolean): string =>
      JSON.stringify({
        model: req.model,
        messages: buildMessages(req),
        temperature: req.temperature,
        max_tokens: req.maxOutputTokens ?? this.maxOutputTokens,
        usage: { include: true },
        // Same effort for every model (fairness). Reasoning text isn't needed, only the answer;
        // OpenRouter ignores this for models without reasoning.
        ...(req.reasoningEffort
          ? { reasoning: { effort: req.reasoningEffort, exclude: true } }
          : {}),
        ...(withTools
          ? {
              tools: [TOOL_DEFINITION],
              tool_choice: { type: 'function', function: { name: TOOL_NAME } },
            }
          : {}),
      });
    const url = `${this.baseUrl}/chat/completions`;

    let json: unknown;
    try {
      json = await this.send(
        url,
        { method: 'POST', headers: this.headers(), body: body(useTools) },
        req.signal,
      );
    } catch (e) {
      // Some models/providers reject `tools` or a forced tool_choice. Remember that and use the JSON
      // fallback instead, so one capability gap doesn't end the run. This applies to every model alike.
      if (
        useTools &&
        e instanceof LlmError &&
        (e.kind === 'bad-request' || e.kind === 'model-unavailable') &&
        /tool/i.test(e.message)
      ) {
        this.noTools.add(req.model);
        json = await this.send(
          url,
          { method: 'POST', headers: this.headers(), body: body(false) },
          req.signal,
        );
      } else {
        throw e;
      }
    }

    const reply = this.readReply(json);
    let choice = parseChoice(reply.raw, req.current.links, req.canGoBack);
    if (choice.kind === 'invalid' && reply.finishReason === 'length') {
      // Usually a reasoning model that spent the whole budget thinking (billed, but no answer).
      choice = {
        ...choice,
        problem: `The reply hit the ${req.maxOutputTokens ?? this.maxOutputTokens}-token limit before giving an answer (it ran out while thinking).`,
      };
    }
    return { choice, usage: reply.usage, latencyMs: Date.now() - started };
  }

  private readReply(json: unknown): {
    raw: { toolArguments?: string; content?: string | null };
    usage: Usage;
    finishReason: string | null;
  } {
    if (!isRecord(json))
      throw new LlmError('bad-response', 'OpenRouter returned an unreadable response');
    // OpenRouter can report upstream failures inside a 200 response.
    const topError = json['error'];
    if (isRecord(topError)) {
      const code = num(topError['code']);
      throw code
        ? errorFromStatus(code, json)
        : new LlmError('bad-response', bodyMessage(json) || 'Provider error');
    }
    const usage = parseUsage(json['usage']);
    const choices = json['choices'];
    const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
    if (!isRecord(first)) throw new LlmError('bad-response', 'OpenRouter response had no choices');
    const choiceError = first['error'];
    if (isRecord(choiceError)) {
      const code = num(choiceError['code']);
      throw code
        ? errorFromStatus(code, { error: choiceError })
        : new LlmError('bad-response', 'Provider error');
    }
    const message = first['message'];
    if (!isRecord(message))
      throw new LlmError('bad-response', 'OpenRouter response had no message');

    let toolArguments: string | undefined;
    const calls = message['tool_calls'];
    if (Array.isArray(calls)) {
      for (const c of calls) {
        if (!isRecord(c)) continue;
        const fn = c['function'];
        if (isRecord(fn) && fn['name'] === TOOL_NAME && typeof fn['arguments'] === 'string') {
          toolArguments = fn['arguments'];
          break;
        }
      }
    }
    const content = typeof message['content'] === 'string' ? message['content'] : null;
    const finish = first['finish_reason'];
    return {
      raw: { ...(toolArguments !== undefined ? { toolArguments } : {}), content },
      usage,
      finishReason: typeof finish === 'string' ? finish : null,
    };
  }
}

export type KeyCheck =
  { ok: true; label: string | null; limitRemaining: number | null } | { ok: false; reason: string };

/** Verifies a key without spending anything. The key is sent only in the Authorization header. */
export async function testApiKey(
  apiKey: string,
  opts: { fetch?: LlmFetch; baseUrl?: string; signal?: AbortSignal } = {},
): Promise<KeyCheck> {
  const fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const trimmed = apiKey.trim();
  if (trimmed === '') return { ok: false, reason: 'Enter your OpenRouter API key.' };
  try {
    const res = await fetchFn(`${opts.baseUrl ?? OPENROUTER.baseUrl}/key`, {
      headers: { Authorization: `Bearer ${trimmed}` },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (res.status === 401 || res.status === 403)
      return { ok: false, reason: 'OpenRouter rejected this key.' };
    if (!res.ok) return { ok: false, reason: `OpenRouter returned HTTP ${res.status}.` };
    const body: unknown = await res.json();
    const data = isRecord(body) && isRecord(body['data']) ? body['data'] : {};
    const remaining = data['limit_remaining'];
    return {
      ok: true,
      label: typeof data['label'] === 'string' ? data['label'] : null,
      limitRemaining: typeof remaining === 'number' ? remaining : null,
    };
  } catch {
    return { ok: false, reason: 'Could not reach OpenRouter.' };
  }
}
