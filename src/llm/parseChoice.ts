/**
 * Turns a raw model reply into a validated `ModelChoice`. Never trust model output: every choice is
 * checked against the list that was actually offered. No DOM.
 */
import { canonicalTitle } from '../wiki/title';
import type { ModelChoice } from './types';

export const TOOL_NAME = 'choose_link';

export interface RawReply {
  /** Arguments of the `choose_link` tool call, as the JSON string the model produced. */
  toolArguments?: string | undefined;
  /** Message text. Used for the JSON fallback when there's no tool call. */
  content?: string | null | undefined;
}

const MAX_REASON = 300;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Find the first balanced `{...}` in text, so replies with code fences or prose still parse. */
export function extractJsonObject(text: string): unknown {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break; // not valid JSON from this start; try the next `{`
        }
      }
    }
  }
  return undefined;
}

function cleanReason(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 ? undefined : t.slice(0, MAX_REASON);
}

/**
 * Some models answer with just the link number (" 12", "13.", "#7") or a number followed by a short
 * note (" 11, \"Captain (association football)\""). A reply that is a single short line starting
 * with a number can only mean that link, so it is read as the index (same rule for every model).
 * Anything longer, multi-line, or starting with a number used in a sentence is not guessed at.
 */
function bareNumberArgs(content: string): Json | undefined {
  const text = content.trim();
  if (text.length === 0 || text.length > MAX_REASON || /[\r\n]/.test(text)) return undefined;
  // Text after the number must follow punctuation, so "12 Angry Men is…" is not read as link 12.
  const m = /^#?(\d{1,4})(?:\s*[.,:;)\-–—]\s*(.*))?$/.exec(text);
  if (!m) return undefined;
  const rest = (m[2] ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^reason\s*:\s*/i, '')
    .trim();
  return rest ? { index: Number(m[1]), reason: rest } : { index: Number(m[1]) };
}

function parseArgs(reply: RawReply): { args: Json } | { problem: string } {
  if (reply.toolArguments !== undefined && reply.toolArguments.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(reply.toolArguments);
      if (isRecord(parsed)) return { args: parsed };
    } catch {
      // Fall through: some models emit slightly broken argument JSON, so try tolerant extraction.
    }
    const loose = extractJsonObject(reply.toolArguments);
    if (isRecord(loose)) return { args: loose };
    return { problem: 'The tool call arguments were not valid JSON.' };
  }
  const content = reply.content ?? '';
  if (content.trim() === '') return { problem: 'The reply was empty.' };
  const parsed = extractJsonObject(content);
  if (isRecord(parsed)) return { args: parsed };
  const bare = bareNumberArgs(content);
  if (bare) return { args: bare };
  return { problem: 'No tool call and no JSON object was found in the reply.' };
}

/**
 * `offered` is the exact link list shown to the model (indexes are 1-based in the prompt).
 * `canGoBack` is false on the first page.
 */
export function parseChoice(
  reply: RawReply,
  offered: readonly string[],
  canGoBack: boolean,
): ModelChoice {
  const raw = (reply.toolArguments ?? reply.content ?? '').slice(0, 500);
  const parsed = parseArgs(reply);
  if ('problem' in parsed) return { kind: 'invalid', problem: parsed.problem, raw };
  const { args } = parsed;
  const reason = cleanReason(args['reason']);
  const withReason = <T extends object>(o: T): T => (reason === undefined ? o : { ...o, reason });

  if (args['back'] === true || args['back'] === 'true' || args['action'] === 'back') {
    if (!canGoBack)
      return { kind: 'invalid', problem: 'There is no previous page to go back to.', raw };
    return withReason({ kind: 'back' as const });
  }

  const rawIndex = args['index'] ?? args['number'] ?? args['choice'];
  const rawTitle = args['title'] ?? args['link'];

  let byIndex: number | undefined;
  if (rawIndex !== undefined && rawIndex !== null && rawIndex !== '') {
    const cleanedRaw =
      typeof rawIndex === 'string'
        ? rawIndex.trim().replace(/^#/, '').replace(/\.$/, '').trim()
        : rawIndex;
    const n =
      typeof cleanedRaw === 'string' && /^\s*\d+\s*$/.test(cleanedRaw)
        ? Number(cleanedRaw)
        : cleanedRaw;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > offered.length) {
      return {
        kind: 'invalid',
        problem: `Index ${JSON.stringify(rawIndex)} is not a number from 1 to ${offered.length}.`,
        raw,
      };
    }
    byIndex = n;
  }

  let byTitle: number | undefined;
  if (typeof rawTitle === 'string' && rawTitle.trim() !== '') {
    const unbracketed = rawTitle
      .trim()
      .replace(/^\[\[(.*)\]\]$/, '$1')
      .trim();
    const wanted = canonicalTitle(unbracketed);
    const i = offered.findIndex((t) => canonicalTitle(t) === wanted);
    if (i === -1) {
      return {
        kind: 'invalid',
        problem: `“${rawTitle.slice(0, 80)}” is not one of the offered links.`,
        raw,
      };
    }
    byTitle = i + 1;
  }

  if (byIndex !== undefined && byTitle !== undefined && byIndex !== byTitle) {
    return { kind: 'invalid', problem: 'The index and the title refer to different links.', raw };
  }
  const index = byTitle ?? byIndex;
  if (index === undefined)
    return { kind: 'invalid', problem: 'Neither an index, a title nor back was given.', raw };
  const title = offered[index - 1];
  if (title === undefined) return { kind: 'invalid', problem: 'Choice out of range.', raw };
  return withReason({ kind: 'link' as const, title, index });
}
