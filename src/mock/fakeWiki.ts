/**
 * An in-memory wiki over an adjacency map. Implements `WikiSource`, so the race engine can't tell it
 * from the real thing. Used by tests and the offline demo. No DOM.
 */
import { canonicalTitle } from '../wiki/title';
import { WikiError, type PageData, type WikiSource } from '../wiki/types';

export type Graph = Record<string, readonly string[]>;

export interface FakeWikiOptions {
  summaries?: Record<string, string>;
  /** alias -> canonical title */
  redirects?: Record<string, string>;
  linkCap?: number;
  /** Simulated network delay for the demo. */
  latencyMs?: number;
  /** Titles whose fetch fails with the given error (to test failure handling). */
  failing?: Record<string, WikiError>;
}

export class FakeWiki implements WikiSource {
  /** Every title requested, in order. */
  readonly requests: string[] = [];
  private readonly graph: Map<string, readonly string[]>;
  private readonly redirects: Map<string, string>;

  constructor(
    graph: Graph,
    private readonly opts: FakeWikiOptions = {},
  ) {
    this.graph = new Map(
      Object.entries(graph).map(([k, v]) => [canonicalTitle(k), v.map(canonicalTitle)]),
    );
    this.redirects = new Map(
      Object.entries(opts.redirects ?? {}).map(([k, v]) => [canonicalTitle(k), canonicalTitle(v)]),
    );
  }

  get titles(): string[] {
    return [...this.graph.keys()];
  }

  async getPage(title: string): Promise<PageData> {
    const asked = canonicalTitle(title);
    this.requests.push(asked);
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    const failure = this.opts.failing?.[asked];
    if (failure) throw failure;
    const resolved = this.redirects.get(asked) ?? asked;
    const all = this.graph.get(resolved);
    if (!all) throw new WikiError('not-found', `No such page: ${asked}`);
    const unique = [...new Set(all)].filter((t) => t !== resolved);
    const cap = this.opts.linkCap ?? Infinity;
    const links = unique.slice(0, cap);
    return {
      title: resolved,
      summary:
        this.opts.summaries?.[resolved] ?? `${resolved} is a topic in the demo encyclopedia.`,
      links,
      totalLinks: unique.length,
      truncated: unique.length > links.length,
      isDisambiguation: false,
    };
  }

  /** Shortest click distance from every page to `target` (BFS over reversed edges). */
  distancesTo(target: string): Map<string, number> {
    const goal = canonicalTitle(target);
    const reverse = new Map<string, string[]>();
    for (const [from, tos] of this.graph) {
      for (const to of tos) {
        const list = reverse.get(to);
        if (list) list.push(from);
        else reverse.set(to, [from]);
      }
    }
    const dist = new Map<string, number>([[goal, 0]]);
    const queue = [goal];
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i] as string;
      const d = dist.get(node) as number;
      for (const prev of reverse.get(node) ?? []) {
        if (!dist.has(prev)) {
          dist.set(prev, d + 1);
          queue.push(prev);
        }
      }
    }
    return dist;
  }
}
