/** Canned racer personalities for the demo and for tests. No DOM. */
import type { LlmError } from '../llm/types';
import type { Decider } from './mockProvider';
export { seededRandom } from '../util/random';

/** Follows the true shortest path; with probability `noise` picks a random link instead. */
export function shortestPathDecider(
  distances: Map<string, number>,
  noise = 0,
  rng: () => number = Math.random,
): Decider {
  return (req) => {
    const links = req.current.links;
    if (links.length === 0) return { back: true, reason: 'Dead end, going back.' };
    if (rng() < noise) {
      const i = Math.floor(rng() * links.length);
      return { index: i + 1, reason: 'Trying something different.' };
    }
    let best = links[0] as string;
    let bestD = Infinity;
    for (const l of links) {
      const d = distances.get(l) ?? Infinity;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    return {
      link: best,
      reason: Number.isFinite(bestD)
        ? `Looks ${bestD} click(s) from the target.`
        : 'No idea, guessing.',
    };
  };
}

/** Random walk. */
export function wandererDecider(rng: () => number = Math.random): Decider {
  return (req) => {
    const links = req.current.links;
    if (links.length === 0) return { back: true };
    return { index: Math.floor(rng() * links.length) + 1, reason: 'This seems interesting.' };
  };
}

/** Keeps returning to pages it has already seen, so it circles. */
export function looperDecider(): Decider {
  return (req) => {
    const seen = new Set(req.path.slice(0, -1));
    const again = req.current.links.find((l) => seen.has(l));
    if (again) return { link: again, reason: 'I recognise this one.' };
    const first = req.current.links[0];
    return first !== undefined ? { link: first } : { back: true };
  };
}

/** Plays the given titles in order, falling back to the first link when one isn't offered. */
export function scriptedDecider(titles: readonly string[]): Decider {
  let i = 0;
  return (req) => {
    const want = titles[i++];
    if (want !== undefined && req.current.links.includes(want)) return { link: want };
    const first = req.current.links[0];
    return first !== undefined ? { link: first } : { back: true };
  };
}

/** Wraps a decider so that every `every`-th call (1-based) returns a garbage reply. */
export function flaky(inner: Decider, every: number): Decider {
  return (req, call) =>
    (call + 1) % every === 0
      ? { garbage: 'I would rather chat about the weather.' }
      : inner(req, call);
}

/** Wraps a decider so that it throws `error` from call number `at` (0-based) onwards. */
export function failingFrom(inner: Decider, at: number, error: LlmError): Decider {
  return (req, call) => (call >= at ? { error } : inner(req, call));
}
