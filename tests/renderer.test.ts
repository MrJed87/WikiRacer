import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphRenderer } from '../src/graph/renderer';
import { GraphSimulation } from '../src/graph/simulation';
import { buildGraph } from '../src/graph/graphModel';
import { ZERO_USAGE } from '../src/llm/types';
import type { RaceEvent, Racer } from '../src/race/types';
import { makeConfig } from './helpers/race';

const racers: Racer[] = [
  { id: 'm1', label: 'Model One', colorIndex: 0 },
  { id: 'm2', label: 'Model Two', colorIndex: 1 },
];

function createMockContext(): CanvasRenderingContext2D {
  return {
    canvas: {} as HTMLCanvasElement,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    globalCompositeOperation: 'source-over',
    font: '',
    textAlign: 'center',
    textBaseline: 'top',
    setTransform: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    strokeText: vi.fn(),
    fillText: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

interface MockElement {
  style: Record<string, string>;
  tabIndex: number;
  attributes: Record<string, string>;
  listeners: Record<string, Array<(e: unknown) => void>>;
  addEventListener: (name: string, fn: (e: unknown) => void) => void;
  removeEventListener: (name: string, fn: (e: unknown) => void) => void;
  dispatchEvent: (event: { type: string }) => boolean;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string;
  getBoundingClientRect: () => { width: number; height: number; left: number; top: number };
  appendChild: (child: unknown) => void;
  remove: () => void;
  setPointerCapture: (id: number) => void;
  releasePointerCapture: (id: number) => void;
  hasPointerCapture: (id: number) => boolean;
  getContext?: (type: string) => CanvasRenderingContext2D;
  width?: number;
  height?: number;
}

function makeMockElement(): MockElement {
  const captured = new Set<number>();
  const el: MockElement = {
    style: {},
    tabIndex: -1,
    attributes: {},
    listeners: {},
    addEventListener(name: string, fn: (e: unknown) => void) {
      if (!this.listeners[name]) this.listeners[name] = [];
      this.listeners[name]!.push(fn);
    },
    removeEventListener(name: string, fn: (e: unknown) => void) {
      if (!this.listeners[name]) return;
      this.listeners[name] = this.listeners[name]!.filter((f) => f !== fn);
    },
    dispatchEvent(event: { type: string }) {
      this.listeners[event.type]?.forEach((f) => f(event));
      return true;
    },
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    },
    getAttribute(k: string) {
      return this.attributes[k] ?? '';
    },
    getBoundingClientRect() {
      return { width: 800, height: 600, left: 0, top: 0 };
    },
    appendChild() {},
    remove: vi.fn(),
    setPointerCapture(id: number) {
      captured.add(id);
    },
    releasePointerCapture(id: number) {
      captured.delete(id);
    },
    hasPointerCapture(id: number) {
      return captured.has(id);
    },
  };
  return el;
}

describe('GraphRenderer', () => {
  const originalDoc = globalThis.document;
  const originalWindow = globalThis.window;
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;

  let container: MockElement;
  let mockCanvas: MockElement;
  let mockCtx: CanvasRenderingContext2D;

  beforeEach(() => {
    container = makeMockElement();
    mockCanvas = makeMockElement();
    mockCtx = createMockContext();
    mockCanvas.getContext = () => mockCtx;

    // Install global document mock for the test
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => (tag === 'canvas' ? mockCanvas : makeMockElement()),
    };

    (globalThis as unknown as { window: unknown }).window = {
      devicePixelRatio: 2,
      matchMedia: () => ({
        matches: false,
        addEventListener: vi.fn(),
      }),
    };

    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback,
    ) => {
      return setTimeout(() => cb(16), 16) as unknown as number;
    };
    (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = (
      id: number,
    ) => {
      clearTimeout(id);
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = originalDoc;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
    (globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame =
      originalRAF;
    (globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = originalCAF;
    vi.restoreAllMocks();
  });

  it('initialises canvas with a11y attributes and sets up DPR viewport', () => {
    const sim = new GraphSimulation();
    const renderer = new GraphRenderer({
      container: container as unknown as HTMLElement,
      simulation: sim,
    });

    expect(mockCanvas.getAttribute('role')).toBe('img');
    expect(mockCanvas.getAttribute('aria-label')).toContain(
      'Interactive force-directed race graph',
    );
    expect(mockCanvas.tabIndex).toBe(0);
    expect(mockCanvas.width).toBe(1600); // 800 * 2 DPR
    expect(mockCanvas.height).toBe(1200); // 600 * 2 DPR
    expect(renderer.camera.width).toBe(800);
    expect(renderer.camera.height).toBe(600);

    renderer.destroy();
    expect(mockCanvas.remove).toHaveBeenCalled();
  });

  it('updates model, syncs simulation, and renders without crashing', async () => {
    const sim = new GraphSimulation();
    const renderer = new GraphRenderer({
      container: container as unknown as HTMLElement,
      simulation: sim,
      getRacer: (id) => racers.find((r) => r.id === id),
    });

    const events: RaceEvent[] = [
      { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
      {
        seq: 1,
        t: 10,
        type: 'StepTaken',
        racerId: 'm1',
        step: 1,
        from: 'Start',
        to: 'Target',
        index: 1,
        usage: ZERO_USAGE,
        latencyMs: 10,
      },
    ];

    const model = buildGraph(events);
    renderer.setModel(model);

    // Wait for at least one animation frame
    await new Promise((r) => setTimeout(r, 40));

    expect(mockCtx.fillRect).toHaveBeenCalled();
    expect(mockCtx.arc).toHaveBeenCalled();

    renderer.destroy();
  });

  describe('node scale', () => {
    /** Radii of every arc drawn in the next frame. */
    async function drawnRadii(renderer: GraphRenderer): Promise<number[]> {
      vi.mocked(mockCtx.arc).mockClear();
      await new Promise((r) => setTimeout(r, 40));
      renderer.destroy();
      return vi.mocked(mockCtx.arc).mock.calls.map((call) => call[2]);
    }

    function startOnlyModel() {
      return buildGraph([
        { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
      ]);
    }

    it('defaults to 1x and clamps to 0.5x - 3x', () => {
      const renderer = new GraphRenderer({
        container: container as unknown as HTMLElement,
        simulation: new GraphSimulation(),
      });
      expect(renderer.getNodeScale()).toBe(1);
      renderer.setNodeScale(10);
      expect(renderer.getNodeScale()).toBe(3);
      renderer.setNodeScale(0);
      expect(renderer.getNodeScale()).toBe(0.5);
      renderer.setNodeScale(1.5);
      expect(renderer.getNodeScale()).toBe(1.5);
      renderer.destroy();
    });

    it('draws the node circles in proportion to the scale', async () => {
      const draw = async (scale: number): Promise<number[]> => {
        const renderer = new GraphRenderer({
          container: container as unknown as HTMLElement,
          simulation: new GraphSimulation(),
        });
        renderer.setNodeScale(scale);
        renderer.setModel(startOnlyModel());
        return drawnRadii(renderer);
      };

      // The start node is 11px at zoom 1 and 1x.
      expect(await draw(1)).toContain(11);
      expect(await draw(2)).toContain(22);
      expect(await draw(3)).toContain(33);
      expect(await draw(0.5)).toContain(5.5);
    });

    it('draws edges and arrowheads thicker or thinner in proportion to the scale', async () => {
      const model = buildGraph([
        { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
        {
          seq: 1,
          t: 10,
          type: 'StepTaken',
          racerId: 'm1',
          step: 1,
          from: 'Start',
          to: 'Target',
          index: 1,
          usage: ZERO_USAGE,
          latencyMs: 10,
        },
      ]);

      /** Line width of the first edge stroke (the glow pass) in a frame. */
      const edgeWidth = async (scale: number): Promise<number> => {
        const widths: number[] = [];
        Object.defineProperty(mockCtx, 'lineWidth', {
          get: () => 1,
          set: (v: number) => widths.push(v),
          configurable: true,
        });
        const renderer = new GraphRenderer({
          container: container as unknown as HTMLElement,
          simulation: new GraphSimulation(),
          getRacer: (id) => racers.find((r) => r.id === id),
        });
        renderer.setNodeScale(scale);
        renderer.setModel(model);
        await new Promise((r) => setTimeout(r, 40));
        renderer.destroy();
        return widths[0]!;
      };

      const normal = await edgeWidth(1);
      expect(await edgeWidth(3)).toBeCloseTo(normal * 3, 5);
      expect(await edgeWidth(2)).toBeCloseTo(normal * 2, 5);
      // Never thinner than a hairline, even at 0.5x.
      expect(await edgeWidth(0.5)).toBeGreaterThan(0.5);
      expect(await edgeWidth(0.5)).toBeLessThan(normal);
    });

    it('keeps the same part of the graph centred when the layout stretches', () => {
      const renderer = new GraphRenderer({
        container: container as unknown as HTMLElement,
        simulation: new GraphSimulation(),
      });
      renderer.camera.x = 100;
      renderer.camera.y = -40;
      renderer.setNodeScale(2);
      expect(renderer.camera.x).toBe(200);
      expect(renderer.camera.y).toBe(-80);
      renderer.setNodeScale(1);
      expect(renderer.camera.x).toBe(100);
      expect(renderer.camera.y).toBe(-40);
      renderer.destroy();
    });

    it('keeps the default hit area when shrinking and grows it when enlarging', () => {
      const onClick = vi.fn();
      const sim = new GraphSimulation();
      const renderer = new GraphRenderer({
        container: container as unknown as HTMLElement,
        simulation: sim,
        onClick,
      });
      renderer.setModel(startOnlyModel());
      renderer.camera.x = 0;
      renderer.camera.y = 0;
      renderer.camera.zoom = 1;

      const node = sim.nodes[0]!;
      node.x = 0;
      node.y = 0;
      const centre = renderer.camera.worldToScreen({ x: 0, y: 0 });
      const down = mockCanvas.listeners['pointerdown']![0]!;
      const move = mockCanvas.listeners['pointermove']![0]!;
      const up = mockCanvas.listeners['pointerup']![0]!;
      const hit = (dx: number): boolean => {
        onClick.mockClear();
        move({ offsetX: centre.x + dx, offsetY: centre.y });
        down({ offsetX: centre.x + dx, offsetY: centre.y, pointerId: 1 });
        up({ pointerId: 1 });
        return onClick.mock.calls.length > 0;
      };

      renderer.setNodeScale(0.5);
      expect(hit(10)).toBe(true);
      expect(hit(30)).toBe(false);

      renderer.setNodeScale(3);
      expect(hit(30)).toBe(true);
      expect(hit(60)).toBe(false);

      renderer.destroy();
    });
  });

  it('handles follow, focus, and hide racer modes', () => {
    const sim = new GraphSimulation();
    const renderer = new GraphRenderer({
      container: container as unknown as HTMLElement,
      simulation: sim,
    });

    expect(renderer.getFollowRacer()).toBeNull();
    renderer.setFollowRacer('m1');
    expect(renderer.getFollowRacer()).toBe('m1');

    expect(renderer.getFocusedRacer()).toBeNull();
    renderer.setFocusedRacer('m2');
    expect(renderer.getFocusedRacer()).toBe('m2');

    expect(renderer.isRacerHidden('m1')).toBe(false);
    renderer.setHiddenRacers(new Set(['m1']));
    expect(renderer.isRacerHidden('m1')).toBe(true);

    renderer.destroy();
  });

  it('handles keyboard navigation and camera fitView', () => {
    const sim = new GraphSimulation();
    const renderer = new GraphRenderer({
      container: container as unknown as HTMLElement,
      simulation: sim,
    });

    const keyListener = mockCanvas.listeners['keydown']?.[0];
    expect(keyListener).toBeDefined();

    const preventDefault = vi.fn();

    // Arrow keys pan
    keyListener!({ key: 'ArrowRight', preventDefault });
    expect(preventDefault).toHaveBeenCalled();

    // Zoom keys
    keyListener!({ key: '+', preventDefault });
    expect(renderer.camera.zoom).toBeGreaterThan(1);

    // Fit view
    renderer.fitView(50, true);

    renderer.destroy();
  });

  it('handles mouse pointer interactions: pan, wheel zoom, hover and click callbacks', () => {
    const sim = new GraphSimulation();
    const onHover = vi.fn();
    const onClick = vi.fn();

    const renderer = new GraphRenderer({
      container: container as unknown as HTMLElement,
      simulation: sim,
      onHover,
      onClick,
    });

    const events: RaceEvent[] = [
      { seq: 0, t: 0, type: 'RaceStarted', config: makeConfig(), racers, startedAtEpochMs: 0 },
    ];
    renderer.setModel(buildGraph(events));

    const downListener = mockCanvas.listeners['pointerdown']?.[0];
    const moveListener = mockCanvas.listeners['pointermove']?.[0];
    const upListener = mockCanvas.listeners['pointerup']?.[0];
    const wheelListener = mockCanvas.listeners['wheel']?.[0];

    expect(downListener).toBeDefined();
    expect(moveListener).toBeDefined();
    expect(upListener).toBeDefined();
    expect(wheelListener).toBeDefined();

    // Wheel zoom
    const preventDefault = vi.fn();
    wheelListener!({ preventDefault, deltaY: -100, offsetX: 400, offsetY: 300 });
    expect(preventDefault).toHaveBeenCalled();
    expect(renderer.camera.zoom).toBeGreaterThan(1);

    // Pan interaction
    downListener!({ offsetX: 200, offsetY: 200, pointerId: 1 });
    moveListener!({ offsetX: 250, offsetY: 250 });
    upListener!({ pointerId: 1 });

    // Hover move
    moveListener!({ offsetX: 400, offsetY: 300 });

    renderer.destroy();
  });
});
