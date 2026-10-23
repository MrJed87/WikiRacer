import { describe, expect, it } from 'vitest';
import { Camera, boundsOf, clampZoom, nearest, MAX_ZOOM, MIN_ZOOM } from '../src/graph/camera';
import {
  applyEvent,
  buildGraph,
  createGraph,
  describeGraph,
  edgeKey,
  visitorsOf,
} from '../src/graph/graphModel';
import { GraphSimulation, LAYOUT } from '../src/graph/simulation';
import { ZERO_USAGE } from '../src/llm/types';
import { replay } from '../src/race/store';
import type { RaceEvent, Racer } from '../src/race/types';
import { looperDecider, shortestPathDecider } from '../src/mock/behaviours';
import { entrant, makeConfig, makeWiki, runRace } from './helpers/race';

const racers: Racer[] = [
  { id: 'a', label: 'Alpha', colorIndex: 0 },
  { id: 'b', label: 'Beta', colorIndex: 1 },
];

let seq = 0;
const ev = (e: Record<string, unknown>): RaceEvent =>
  ({ seq: seq++, t: seq * 10, ...e }) as RaceEvent;
const started = (start = 'Start', target = 'Target') =>
  ev({ type: 'RaceStarted', config: makeConfig({ start, target }), racers, startedAtEpochMs: 0 });
const step = (racerId: string, from: string, to: string) =>
  ev({ type: 'StepTaken', racerId, step: 1, from, to, index: 1, usage: ZERO_USAGE, latencyMs: 1 });

describe('graphModel', () => {
  it('starts with the start and target nodes and every racer at the start', () => {
    seq = 0;
    const g = buildGraph([started()]);
    expect([...g.nodes.keys()].sort()).toEqual(['Start', 'Target']);
    expect(g.nodes.get('Start')).toMatchObject({ isStart: true, isTarget: false, total: 2 });
    expect(g.nodes.get('Target')).toMatchObject({ isTarget: true, total: 0 });
    expect(g.heads.get('a')).toBe('Start');
    expect(g.racerIds).toEqual(['a', 'b']);
  });

  it('tracks nodes, directed per-racer edge counts, parents and heads', () => {
    seq = 0;
    const g = buildGraph([
      started(),
      step('a', 'Start', 'X'),
      step('b', 'Start', 'X'),
      step('a', 'X', 'Y'),
      step('a', 'Y', 'X'),
    ]);
    expect(g.nodes.get('X')).toMatchObject({ parent: 'Start', total: 3, visits: { a: 2, b: 1 } });
    expect(g.nodes.get('Y')?.parent).toBe('X');
    expect(g.edges.get(edgeKey('Start', 'X'))?.counts).toEqual({ a: 1, b: 1 });
    expect(g.edges.get(edgeKey('Y', 'X'))?.counts).toEqual({ a: 1 });
    expect(g.heads.get('a')).toBe('X');
    expect(g.heads.get('b')).toBe('X');
    expect(visitorsOf(g, g.nodes.get('X')!)).toEqual(['a', 'b']);
    expect(visitorsOf(g, g.nodes.get('Y')!)).toEqual(['a']);
  });

  it('links to the target node once it is reached, rather than creating a second one', () => {
    seq = 0;
    const g = buildGraph([started(), step('a', 'Start', 'Target')]);
    expect(g.nodes.size).toBe(2);
    expect(g.nodes.get('Target')).toMatchObject({ isTarget: true, total: 1, parent: null });
  });

  it('treats back as an edge traversal without counting a visit', () => {
    seq = 0;
    const g = buildGraph([
      started(),
      step('a', 'Start', 'X'),
      ev({
        type: 'WentBack',
        racerId: 'a',
        step: 2,
        from: 'X',
        to: 'Start',
        usage: ZERO_USAGE,
        latencyMs: 1,
      }),
    ]);
    expect(g.nodes.get('Start')?.visits['a']).toBe(1);
    expect(g.edges.get(edgeKey('X', 'Start'))?.counts).toEqual({ a: 1 });
    expect(g.heads.get('a')).toBe('Start');
  });

  it('records how each racer finished, and stops the rest when the race ends', () => {
    seq = 0;
    const g = buildGraph([
      started(),
      ev({ type: 'Arrived', racerId: 'a', steps: 1, title: 'Target' }),
      ev({ type: 'RaceEnded', reason: 'user-stopped' }),
    ]);
    expect(g.finished.get('a')).toBe('arrived');
    expect(g.finished.get('b')).toBe('stopped');
  });

  it('only bumps the version when something visual changed, and ignores unknown racers', () => {
    seq = 0;
    const g = createGraph();
    applyEvent(g, started());
    const v = g.version;
    applyEvent(g, ev({ type: 'Revisited', racerId: 'a', title: 'X', visits: 2 }));
    applyEvent(g, ev({ type: 'RacePaused' }));
    applyEvent(g, step('ghost', 'Start', 'Nope'));
    expect(g.version).toBe(v);
    expect(g.nodes.has('Nope')).toBe(false);
    applyEvent(g, step('a', 'Start', 'X'));
    expect(g.version).toBe(v + 1);
  });

  it('resets on a new RaceStarted', () => {
    seq = 0;
    const g = buildGraph([started(), step('a', 'Start', 'X')]);
    applyEvent(g, started());
    expect(g.nodes.has('X')).toBe(false);
    expect(g.edges.size).toBe(0);
  });

  it('describes the state for screen readers', () => {
    seq = 0;
    const g = buildGraph([
      started(),
      step('a', 'Start', 'X'),
      ev({ type: 'GaveUp', racerId: 'b', steps: 3 }),
    ]);
    const text = describeGraph(g, (id) => (id === 'a' ? 'Alpha' : 'Beta'));
    expect(text).toContain('3 articles');
    expect(text).toContain('Alpha: racing at X.');
    expect(text).toContain('Beta: gave-up at Start.');
  });

  it('live graph equals graph rebuilt from the log of a real race, including after JSON round trip', async () => {
    const distances = makeWiki().distancesTo('Target');
    const { store } = await runRace({
      entrants: [
        entrant('smart', shortestPathDecider(distances)),
        entrant('loop', looperDecider()),
      ],
    });
    const live = createGraph();
    for (const e of store.events) applyEvent(live, e);
    const rebuilt = buildGraph(JSON.parse(JSON.stringify(store.events)) as RaceEvent[]);
    expect([...rebuilt.nodes.entries()]).toEqual([...live.nodes.entries()]);
    expect([...rebuilt.edges.entries()]).toEqual([...live.edges.entries()]);
    expect(live.finished.get('smart')).toBe('arrived');
    expect(live.nodes.get('Target')?.visits['smart']).toBe(1);
    // Consistent with the reducer's own view.
    const state = replay(store.events);
    expect(live.heads.get('loop')).toBe(state.racers['loop']?.current);
  });
});

describe('Camera', () => {
  const cam = () => {
    const c = new Camera();
    c.setViewport(800, 600);
    return c;
  };

  it('round-trips world and screen coordinates', () => {
    const c = cam();
    c.x = 120;
    c.y = -40;
    c.zoom = 2.5;
    const s = c.worldToScreen({ x: 10, y: 20 });
    const w = c.screenToWorld(s);
    expect(w.x).toBeCloseTo(10);
    expect(w.y).toBeCloseTo(20);
    expect(c.worldToScreen({ x: 120, y: -40 })).toEqual({ x: 400, y: 300 });
  });

  it('pans by screen deltas at any zoom', () => {
    const c = cam();
    c.zoom = 2;
    c.panBy(100, 0);
    expect(c.x).toBe(-50);
  });

  it('zooms about the cursor, keeping the point under it fixed, and clamps', () => {
    const c = cam();
    const cursor = { x: 600, y: 200 };
    const before = c.screenToWorld(cursor);
    c.zoomAt(cursor, 2);
    const after = c.screenToWorld(cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(c.zoom).toBe(2);
    c.zoomAt(cursor, 1e9);
    expect(c.zoom).toBe(MAX_ZOOM);
    c.zoomAt(cursor, 1e-9);
    expect(c.zoom).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it('frames bounds and eases towards a target', () => {
    const c = cam();
    const f = c.framing({ minX: -500, minY: -100, maxX: 500, maxY: 100 }, 50);
    expect(f.x).toBe(0);
    expect(f.zoom).toBeCloseTo(0.7);
    c.easeTo(f, 160, 160);
    expect(c.zoom).toBeLessThan(1);
    expect(c.zoom).toBeGreaterThan(f.zoom);
    c.easeTo(f, 0, 160, true);
    expect(c.zoom).toBeCloseTo(f.zoom);
    expect(c.framing({ minX: 0, minY: 0, maxX: 0, maxY: 0 }).zoom).toBeLessThanOrEqual(1.6);
  });

  it('computes bounds (ignoring non-finite points) and finds the nearest item', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { x: 1, y: 2 },
        { x: -3, y: 5 },
        { x: NaN, y: 0 },
      ]),
    ).toEqual({ minX: -3, minY: 2, maxX: 1, maxY: 5 });
    const items = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
    ];
    expect(nearest(items, { x: 8, y: 1 }, 5)?.id).toBe('b');
    expect(nearest(items, { x: 100, y: 100 }, 5)).toBeNull();
  });
});

describe('GraphSimulation', () => {
  const chainGraph = (n: number) => {
    seq = 0;
    const events = [started()];
    for (let i = 0; i < n; i++) events.push(step('a', i === 0 ? 'Start' : `N${i - 1}`, `N${i}`));
    return events;
  };

  it('places new nodes near their parent and keeps every coordinate finite', () => {
    const g = createGraph();
    const sim = new GraphSimulation(1);
    for (const e of chainGraph(3)) applyEvent(g, e);
    expect(sim.sync(g)).toBe(true);
    const start = sim.nodeById('Start')!;
    const n0 = sim.nodeById('N0')!;
    expect(Math.hypot(n0.x - start.x, n0.y - start.y)).toBeLessThanOrEqual(LAYOUT.spawnMax + 1e-6);
    expect(Math.hypot(sim.nodeById('Target')!.x, sim.nodeById('Target')!.y)).toBeCloseTo(
      LAYOUT.targetSpawnDistance,
    );
    sim.step(50);
    for (const n of sim.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  it('syncs incrementally and only when the model version changes', () => {
    const g = createGraph();
    const sim = new GraphSimulation(1);
    const events = chainGraph(4);
    for (const e of events.slice(0, 3)) applyEvent(g, e);
    sim.sync(g);
    const before = sim.nodes.length;
    expect(sim.sync(g)).toBe(false);
    applyEvent(g, events[3]!);
    expect(sim.sync(g)).toBe(true);
    expect(sim.nodes.length).toBe(before + 1);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const g = createGraph();
      const sim = new GraphSimulation(42);
      for (const e of chainGraph(6)) applyEvent(g, e);
      sim.sync(g);
      sim.step(30);
      return sim.nodes.map((n) => [n.x.toFixed(6), n.y.toFixed(6)]);
    };
    expect(run()).toEqual(run());
  });

  it('settles, then step() becomes a no-op until something changes', () => {
    const g = createGraph();
    const sim = new GraphSimulation(1);
    for (const e of chainGraph(5)) applyEvent(g, e);
    sim.sync(g);
    expect(sim.active).toBe(true);
    sim.step(2000);
    expect(sim.active).toBe(false);
    const snapshot = sim.nodes.map((n) => n.x);
    sim.step(10);
    expect(sim.nodes.map((n) => n.x)).toEqual(snapshot);
  });

  it('handles 600 nodes and resets for a new race', () => {
    const g = createGraph();
    const sim = new GraphSimulation(1);
    for (const e of chainGraph(600)) applyEvent(g, e);
    sim.sync(g);
    sim.step(5);
    expect(sim.nodes).toHaveLength(602);
    seq = 0;
    applyEvent(g, started());
    sim.sync(g);
    expect(sim.nodes).toHaveLength(2);
  });

  it('resets cleanly when node IDs change even with the same total node count', () => {
    const g1 = createGraph();
    const sim = new GraphSimulation(1);
    applyEvent(g1, started('StartA', 'TargetA'));
    sim.sync(g1);
    expect(sim.nodes.map((n) => n.id)).toEqual(['StartA', 'TargetA']);

    const g2 = createGraph();
    applyEvent(g2, started('StartB', 'TargetB'));
    sim.sync(g2);
    expect(sim.nodes.map((n) => n.id)).toEqual(['StartB', 'TargetB']);
    expect(sim.nodeById('StartA')).toBeUndefined();
  });

  describe('replay stepping (a different graph object each step)', () => {
    const log = () => {
      seq = 0;
      return [started(), step('a', 'Start', 'X'), step('a', 'X', 'Y'), step('a', 'Y', 'Z')];
    };

    it('keeps existing nodes where they are when stepping forward', () => {
      const events = log();
      const sim = new GraphSimulation(1);
      sim.sync(buildGraph(events.slice(0, 2)));
      sim.step(300);
      const before = ['Start', 'Target', 'X'].map((id) => ({ ...sim.nodeById(id)! }));
      expect(sim.active).toBe(false);

      // A fresh graph object for the next step, exactly as the replay controller supplies.
      expect(sim.sync(buildGraph(events.slice(0, 3)))).toBe(true);
      expect(sim.nodes.map((n) => n.id).sort()).toEqual(['Start', 'Target', 'X', 'Y']);
      // The new node is born beside its parent, and nothing else was teleported.
      const x = sim.nodeById('X')!;
      const y = sim.nodeById('Y')!;
      expect(Math.hypot(y.x - x.x, y.y - x.y)).toBeLessThanOrEqual(LAYOUT.spawnMax + 1);
      for (const b of before) {
        expect(sim.nodeById(b.id)).toMatchObject({ x: b.x, y: b.y });
      }
    });

    it('keeps ticking when handed an identical graph object (an event that changes nothing visual)', () => {
      const events = log();
      const sim = new GraphSimulation(1);
      sim.sync(buildGraph(events));
      sim.step(5);
      expect(sim.sync(buildGraph(events))).toBe(false);
      expect(() => sim.step(5)).not.toThrow();
      expect(sim.nodes.every((n) => typeof n.x === 'number' && !Number.isNaN(n.x))).toBe(true);
    });

    it('removes only the latest nodes and links when stepping back', () => {
      const events = log();
      const sim = new GraphSimulation(1);
      sim.sync(buildGraph(events));
      sim.step(300);
      const start = { ...sim.nodeById('Start')! };

      expect(sim.sync(buildGraph(events.slice(0, 3)))).toBe(true);
      expect(sim.nodes.map((n) => n.id).sort()).toEqual(['Start', 'Target', 'X', 'Y']);
      expect(sim.nodeById('Z')).toBeUndefined();
      expect(sim.nodeById('Start')).toMatchObject({ x: start.x, y: start.y });
    });

    it('drops a link that disappears even when both of its nodes remain', () => {
      seq = 0;
      const events = [
        started(),
        step('a', 'Start', 'X'),
        step('a', 'X', 'Y'),
        step('a', 'Y', 'Start'), // a new link between two articles already visited
      ];
      const sim = new GraphSimulation(1);
      sim.sync(buildGraph(events));
      const linkCount = () => (sim as unknown as { links: unknown[] }).links.length;
      const full = linkCount();
      sim.sync(buildGraph(events.slice(0, 3)));
      expect(linkCount()).toBeLessThan(full);
    });
  });

  it('pins and releases nodes', () => {
    const g = createGraph();
    const sim = new GraphSimulation(1);
    for (const e of chainGraph(2)) applyEvent(g, e);
    sim.sync(g);
    sim.pin('N0', 5, 6);
    sim.step(5);
    expect(sim.nodeById('N0')).toMatchObject({ x: 5, y: 6 });
    sim.unpin('N0');
    expect(sim.nodeById('N0')?.fx).toBeNull();
    sim.pin('missing', 0, 0);
    sim.unpin('missing');
  });
});
