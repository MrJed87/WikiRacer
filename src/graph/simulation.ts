/**
 * Force layout. Wraps `d3-force` (simulation only, no d3 DOM) and keeps it in sync with the graph
 * model *incrementally*: new nodes are born next to the node that led to them so the layout grows
 * outward instead of exploding. Ticking is manual so the caller can throttle it independently of
 * rendering, which keeps the layout smooth with hundreds of nodes.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { seededRandom } from '../util/random';
import type { GraphModel } from './graphModel';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
}

type SimLink = SimulationLinkDatum<SimNode>;

export const LAYOUT = {
  linkDistance: 62,
  linkStrength: 0.55,
  charge: -130,
  chargeMaxDistance: 380,
  gravity: 0.035,
  // Leaves room for 15px picture nodes plus their rings without overlap.
  collideRadius: 18,
  /** How far from its parent a new node is born. */
  spawnMin: 34,
  spawnMax: 64,
  /** Where the (initially unreached) target sits. */
  targetSpawnDistance: 340,
  alphaOnChange: 0.5,
  alphaMin: 0.003,
} as const;

export class GraphSimulation {
  readonly nodes: SimNode[] = [];
  private readonly byId = new Map<string, SimNode>();
  private readonly links: SimLink[] = [];
  private readonly linkKeys = new Set<string>();
  private readonly sim: Simulation<SimNode, SimLink>;
  private readonly link = forceLink<SimNode, SimLink>([])
    .id((d) => d.id)
    .distance(LAYOUT.linkDistance)
    .strength(LAYOUT.linkStrength);
  private seenVersion = -1;
  private lastModel: GraphModel | null = null;
  private readonly rng: () => number;

  constructor(seed = 1) {
    this.rng = seededRandom(seed);
    this.sim = forceSimulation<SimNode, SimLink>(this.nodes)
      .force('link', this.link)
      .force(
        'charge',
        forceManyBody<SimNode>()
          .strength(LAYOUT.charge)
          .distanceMax(LAYOUT.chargeMaxDistance)
          .theta(0.9),
      )
      .force('collide', forceCollide<SimNode>(LAYOUT.collideRadius))
      // Gentle gravity (rather than forceCenter) keeps disconnected pieces, like the unreached target, in view.
      .force('x', forceX<SimNode>(0).strength(LAYOUT.gravity))
      .force('y', forceY<SimNode>(0).strength(LAYOUT.gravity))
      .alphaMin(LAYOUT.alphaMin)
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .stop();
  }

  get alpha(): number {
    return this.sim.alpha();
  }

  /** True while the layout is still moving enough to be worth ticking. */
  get active(): boolean {
    return this.sim.alpha() > this.sim.alphaMin();
  }

  nodeById(id: string): SimNode | undefined {
    return this.byId.get(id);
  }

  /** Re-sync with the model if it changed. Returns whether anything was added. */
  sync(model: GraphModel): boolean {
    const isNewInstance = this.lastModel !== null && this.lastModel !== model;
    if (!isNewInstance && model.version === this.seenVersion) return false;

    // A new race or replay scrub resets the graph; start over rather than diff if node set changed
    const needsReset =
      isNewInstance ||
      this.seenVersion > model.version ||
      (this.nodes.length > 0 &&
        (model.nodes.size < this.nodes.length || this.nodes.some((n) => !model.nodes.has(n.id))));
    if (needsReset) this.reset();

    this.lastModel = model;
    this.seenVersion = model.version;

    let changed = false;
    for (const node of model.nodes.values()) {
      if (this.byId.has(node.id)) continue;
      this.addNode(node.id, node.parent, node.isTarget);
      changed = true;
    }
    for (const edge of model.edges.values()) {
      if (edge.from === edge.to) continue;
      const key =
        edge.from < edge.to ? `${edge.from}\u0000${edge.to}` : `${edge.to}\u0000${edge.from}`;
      if (this.linkKeys.has(key)) continue;
      const a = this.byId.get(edge.from);
      const b = this.byId.get(edge.to);
      if (!a || !b) continue;
      this.linkKeys.add(key);
      this.links.push({ source: a.id, target: b.id });
      changed = true;
    }
    if (changed || needsReset) {
      this.sim.nodes(this.nodes);
      this.link.links(this.links);
      this.reheat(LAYOUT.alphaOnChange);
    }
    return changed;
  }

  private reset(): void {
    this.nodes.length = 0;
    this.links.length = 0;
    this.byId.clear();
    this.linkKeys.clear();
  }

  private addNode(id: string, parentId: string | null, isTarget: boolean): void {
    const parent = parentId !== null ? this.byId.get(parentId) : undefined;
    const angle = this.rng() * Math.PI * 2;
    let x: number;
    let y: number;
    if (isTarget && !parent) {
      // Show the goal as a distant beacon.
      x = Math.cos(angle) * LAYOUT.targetSpawnDistance;
      y = Math.sin(angle) * LAYOUT.targetSpawnDistance;
    } else if (parent) {
      const r = LAYOUT.spawnMin + this.rng() * (LAYOUT.spawnMax - LAYOUT.spawnMin);
      x = parent.x + Math.cos(angle) * r;
      y = parent.y + Math.sin(angle) * r;
    } else {
      x = 0;
      y = 0;
    }
    const node: SimNode = { id, x, y };
    this.nodes.push(node);
    this.byId.set(id, node);
  }

  reheat(alpha: number): void {
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  /** Advance the layout. Cheap no-op once it has settled. */
  step(iterations = 1): void {
    for (let i = 0; i < iterations && this.active; i++) this.sim.tick();
  }

  /** Hold a node under the pointer while dragging. */
  pin(id: string, x: number, y: number): void {
    const n = this.byId.get(id);
    if (!n) return;
    n.fx = x;
    n.fy = y;
    this.reheat(0.25);
  }

  unpin(id: string): void {
    const n = this.byId.get(id);
    if (!n) return;
    n.fx = null;
    n.fy = null;
  }
}
