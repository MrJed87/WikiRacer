/**
 * The graph as derived from the race event log. Pure data: no canvas, no DOM, no simulation.
 * Live play and replay both feed events through `applyEvent`, so they always draw the same thing.
 */
import type { RaceEvent, RacerStatus } from '../race/types';

export interface GraphNode {
  id: string;
  /** Log position of the first event that mentioned this node (-1 for the target before it is reached). */
  firstSeq: number;
  /** Visits per racer id. */
  visits: Record<string, number>;
  total: number;
  isStart: boolean;
  isTarget: boolean;
  /** The node that first led here, so the simulation can place newcomers beside it. */
  parent: string | null;
}

export interface GraphEdge {
  /** `from\u0000to`: directed. */
  key: string;
  from: string;
  to: string;
  /** Traversals per racer id (a `back` move counts as a traversal of the reverse edge). */
  counts: Record<string, number>;
  firstSeq: number;
}

export interface GraphModel {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  /** Where each racer is right now. */
  heads: Map<string, string>;
  /** Final status for racers that have finished. */
  finished: Map<string, RacerStatus>;
  racerIds: string[];
  start: string | null;
  target: string | null;
  /** Bumped on every change so consumers can cheaply tell whether to re-sync. */
  version: number;
}

export function createGraph(): GraphModel {
  return {
    nodes: new Map(),
    edges: new Map(),
    heads: new Map(),
    finished: new Map(),
    racerIds: [],
    start: null,
    target: null,
    version: 0,
  };
}

function ensureNode(g: GraphModel, id: string, seq: number, parent: string | null): GraphNode {
  let node = g.nodes.get(id);
  if (!node) {
    node = {
      id,
      firstSeq: seq,
      visits: {},
      total: 0,
      isStart: id === g.start,
      isTarget: id === g.target,
      parent,
    };
    g.nodes.set(id, node);
  }
  return node;
}

export const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

function traverse(
  g: GraphModel,
  racerId: string,
  from: string,
  to: string,
  seq: number,
  countVisit: boolean,
): void {
  ensureNode(g, from, seq, null);
  const dest = ensureNode(g, to, seq, from);
  if (countVisit) {
    dest.visits[racerId] = (dest.visits[racerId] ?? 0) + 1;
    dest.total++;
  }
  const key = edgeKey(from, to);
  let edge = g.edges.get(key);
  if (!edge) {
    edge = { key, from, to, counts: {}, firstSeq: seq };
    g.edges.set(key, edge);
  }
  edge.counts[racerId] = (edge.counts[racerId] ?? 0) + 1;
  g.heads.set(racerId, to);
}

const TERMINAL: Partial<Record<RaceEvent['type'], RacerStatus>> = {
  Arrived: 'arrived',
  GaveUp: 'gave-up',
  BudgetExceeded: 'out-of-budget',
  Stuck: 'stuck',
  AgentFailed: 'failed',
};

/** Mutates `g` in place (it is derived data, not store state). Unknown racers' events are ignored. */
export function applyEvent(g: GraphModel, event: RaceEvent): void {
  switch (event.type) {
    case 'RaceStarted': {
      g.nodes.clear();
      g.edges.clear();
      g.heads.clear();
      g.finished.clear();
      g.start = event.config.start;
      g.target = event.config.target;
      g.racerIds = event.racers.map((r) => r.id);
      const start = ensureNode(g, event.config.start, event.seq, null);
      for (const id of g.racerIds) {
        start.visits[id] = 1;
        start.total++;
        g.heads.set(id, start.id);
      }
      ensureNode(g, event.config.target, event.seq, null);
      break;
    }
    case 'StepTaken':
      if (!g.racerIds.includes(event.racerId)) return;
      traverse(g, event.racerId, event.from, event.to, event.seq, true);
      break;
    case 'WentBack':
      if (!g.racerIds.includes(event.racerId)) return;
      traverse(g, event.racerId, event.from, event.to, event.seq, false);
      break;
    case 'RaceEnded':
      for (const id of g.racerIds) if (!g.finished.has(id)) g.finished.set(id, 'stopped');
      break;
    default: {
      const status = TERMINAL[event.type];
      if (status !== undefined && 'racerId' in event && g.racerIds.includes(event.racerId)) {
        g.finished.set(event.racerId, status);
        break;
      }
      return; // Nothing visual changed; don't bump the version.
    }
  }
  g.version++;
}

export function buildGraph(events: readonly RaceEvent[]): GraphModel {
  const g = createGraph();
  for (const e of events) applyEvent(g, e);
  return g;
}

/** Racer ids that have visited a node, in racer order. Used for the node's ring segments and tooltip. */
export function visitorsOf(g: GraphModel, node: GraphNode): string[] {
  return g.racerIds.filter((id) => (node.visits[id] ?? 0) > 0);
}

/** One-line text description of the current state, for screen readers. */
export function describeGraph(g: GraphModel, labelOf: (racerId: string) => string): string {
  const parts = [`${g.nodes.size} articles visited or targeted, ${g.edges.size} links followed.`];
  for (const id of g.racerIds) {
    const status = g.finished.get(id);
    parts.push(
      `${labelOf(id)}: ${status ? status : 'racing'} at ${g.heads.get(id) ?? 'the start'}.`,
    );
  }
  return parts.join(' ');
}
