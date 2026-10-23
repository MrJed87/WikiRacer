/**
 * Canvas 2D Neon Graph Renderer.
 *
 * Implements decoupled simulation and render loop, additive neon blending glow,
 * multi-racer edge offsets, repeated-edge thickening (circling visibility),
 * animated head pulses, start/target beacons, dynamic label culling,
 * interactive pan/zoom/node-drag, tooltip hit-testing, and follow-camera mode.
 *
 * Respects `prefers-reduced-motion` to tone down pulses and avoid rapid flashing.
 */
import { clampNodeScale, NODE_SCALE } from '../config';
import { Camera, boundsOf, nearest, type Point } from './camera';
import { GRAPH_COLORS, racerColor, withAlpha } from './palette';
import type { GraphModel, GraphNode } from './graphModel';
import type { GraphSimulation } from './simulation';
import type { Racer } from '../race/types';

export interface RendererOptions {
  container: HTMLElement;
  simulation: GraphSimulation;
  /** Lookup racer metadata (label, colorIndex) by racer id. */
  getRacer?: (id: string) => Racer | undefined;
  /** Called when the hovered node changes (or null when pointer leaves). */
  onHover?: (node: GraphNode | null, screenPos: Point | null) => void;
  /** Called when a node is clicked. */
  onClick?: (node: GraphNode) => void;
  /** Returns whether replay mode is currently active (yields arrow keys to replay scrubbing). */
  isReplayActive?: () => boolean;
  /** Optional initial reduced motion override (defaults to media query). */
  reducedMotion?: boolean;
}

export class GraphRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly container: HTMLElement;
  private readonly sim: GraphSimulation;
  readonly camera: Camera = new Camera();

  private model: GraphModel | null = null;
  private readonly getRacer?: (id: string) => Racer | undefined;
  private readonly onHover?: (node: GraphNode | null, screenPos: Point | null) => void;
  private readonly onClick?: (node: GraphNode) => void;
  private readonly isReplayActive?: () => boolean;

  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private isDestroyed = false;

  // Interaction state
  private hoveredNode: GraphNode | null = null;
  private draggedNodeId: string | null = null;
  private isPanning = false;
  private lastPointerPos: Point = { x: 0, y: 0 };
  private pointerDownPos: Point = { x: 0, y: 0 };
  private hasMovedDuringDrag = false;

  // Camera tracking & focus
  private followRacerId: string | null = null;
  private focusedRacerId: string | null = null;
  private hiddenRacers = new Set<string>();

  // Article thumbnails drawn inside nodes (fetched by the app, loaded here as images).
  private thumbnailsEnabled = true;
  private readonly images = new Map<string, HTMLImageElement>();

  // Node size multiplier (circles, pictures, head markers and hit areas).
  private nodeScale: number = NODE_SCALE.default;

  // Reduced motion preference
  private reducedMotion = false;
  private mediaQueryList: MediaQueryList | null = null;

  // Timing
  private lastSimTickTime = 0;
  private lastFrameTime = 0;

  constructor(opts: RendererOptions) {
    this.container = opts.container;
    this.sim = opts.simulation;
    this.getRacer = opts.getRacer;
    this.onHover = opts.onHover;
    this.onClick = opts.onClick;
    this.isReplayActive = opts.isReplayActive;

    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    this.canvas.tabIndex = 0; // Focusable for keyboard nav
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive force-directed race graph');
    this.container.appendChild(this.canvas);

    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Could not get 2D canvas context');
    this.ctx = context;

    this.setupReducedMotion(opts.reducedMotion);
    this.setupResizeObserver();
    this.setupEventListeners();

    this.resize();
    this.startLoop();
  }

  private setupReducedMotion(explicitPref?: boolean): void {
    if (explicitPref !== undefined) {
      this.reducedMotion = explicitPref;
      return;
    }
    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mediaQueryList = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this.mediaQueryList.matches;
      this.mediaQueryList.addEventListener('change', (e) => {
        this.reducedMotion = e.matches;
      });
    }
  }

  private setupResizeObserver(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.resize();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.camera.setViewport(width, height);
  }

  /** Show or hide article thumbnails inside nodes. */
  setThumbnailsEnabled(enabled: boolean): void {
    this.thumbnailsEnabled = enabled;
  }

  /** Attach a thumbnail URL to a node id (title). The image is drawn once it has loaded. */
  setNodeImage(id: string, url: string): void {
    if (this.images.has(id) || typeof Image === 'undefined') return;
    const img = new Image();
    img.decoding = 'async';
    // Wikimedia asks for a referrer policy that doesn't leak full URLs; the canvas never reads
    // pixels back, so no CORS mode is needed.
    img.referrerPolicy = 'origin';
    img.src = url;
    this.images.set(id, img);
  }

  /**
   * Resize every node (and the picture inside it) by this multiplier, within the allowed range.
   * Edges follow: thicker or thinner lines and arrowheads here, longer or shorter in the layout.
   */
  setNodeScale(scale: number): void {
    const next = clampNodeScale(scale);
    const ratio = next / this.nodeScale;
    this.nodeScale = next;
    this.sim.setNodeScale(next);
    // The layout stretches about the origin; carry the camera with it so the same part of the
    // graph stays in the middle of the screen.
    this.camera.x *= ratio;
    this.camera.y *= ratio;
  }

  getNodeScale(): number {
    return this.nodeScale;
  }

  /** Screen radius of a node's disc at the current zoom, optionally for a different node scale. */
  private nodeRadius(node: GraphNode, hasImage: boolean, scale = this.nodeScale): number {
    const baseRadius = node.isStart
      ? 11
      : node.isTarget
        ? 13
        : Math.min(5 + Math.log2(node.total + 1) * 2, 14);
    const zoomScale = Math.min(Math.max(this.camera.zoom, 0.6), 2);
    // Nodes with a picture grow a little so the thumbnail is recognisable.
    return Math.max(4, Math.max(baseRadius, hasImage ? 15 : 0) * zoomScale) * scale;
  }

  /** How close (in world units) a pointer must be to a node centre to hit it. */
  private hitRadiusWorld(): number {
    // Bigger nodes get a bigger hit area; smaller ones keep the default so they stay easy to grab.
    return (18 * Math.max(1, this.nodeScale)) / this.camera.zoom;
  }

  private readyImage(id: string): HTMLImageElement | null {
    if (!this.thumbnailsEnabled) return null;
    const img = this.images.get(id);
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  /**
   * Fills the node disc with its thumbnail (cover-cropped) or a flat colour, and leaves the circle
   * as the current path so callers can stroke rings on it.
   */
  private fillNodeDisc(
    p: { x: number; y: number },
    radius: number,
    fill: string,
    img: HTMLImageElement | null,
  ): void {
    const ctx = this.ctx;
    if (img) {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - side) / 2;
      const sy = (img.naturalHeight - side) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, sx, sy, side, side, p.x - radius, p.y - radius, radius * 2, radius * 2);
      ctx.restore();
    } else {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  }

  /** Set or update the graph model to render. */
  setModel(model: GraphModel): void {
    this.model = model;
    this.sim.sync(model);
  }

  setFollowRacer(racerId: string | null): void {
    this.followRacerId = racerId;
  }

  getFollowRacer(): string | null {
    return this.followRacerId;
  }

  setFocusedRacer(racerId: string | null): void {
    this.focusedRacerId = racerId;
  }

  getFocusedRacer(): string | null {
    return this.focusedRacerId;
  }

  setHiddenRacers(racerIds: Set<string>): void {
    this.hiddenRacers = new Set(racerIds);
  }

  isRacerHidden(racerId: string): boolean {
    return this.hiddenRacers.has(racerId);
  }

  /** Frame all nodes within viewport with padding. */
  fitView(padding = 70, instant = false): void {
    if (!this.sim.nodes.length) return;
    const bounds = boundsOf(this.sim.nodes);
    if (!bounds) return;
    const target = this.camera.framing(bounds, padding);
    if (instant || this.reducedMotion) {
      this.camera.x = target.x;
      this.camera.y = target.y;
      this.camera.zoom = target.zoom;
    } else {
      this.camera.easeTo(target, 400, 100);
    }
  }

  /** Central render and simulation loop. */
  private startLoop(): void {
    const tick = (now: number): void => {
      if (this.isDestroyed) return;

      const dt = this.lastFrameTime ? Math.min(now - this.lastFrameTime, 100) : 16;
      this.lastFrameTime = now;

      // Throttle simulation ticks to ~40Hz max for performance stability
      if (now - this.lastSimTickTime >= 24 && this.sim.active) {
        this.sim.step(1);
        this.lastSimTickTime = now;
      }

      // Update follow camera target
      if (this.followRacerId && this.model) {
        const headNodeId = this.model.heads.get(this.followRacerId);
        if (headNodeId) {
          const simNode = this.sim.nodeById(headNodeId);
          if (simNode) {
            this.camera.easeTo(
              { x: simNode.x, y: simNode.y, zoom: Math.max(this.camera.zoom, 0.9) },
              dt,
              180,
              this.reducedMotion,
            );
          }
        }
      }

      this.render(now);
      this.animationFrameId = requestAnimationFrame(tick);
    };

    this.animationFrameId = requestAnimationFrame(tick);
  }

  private render(now: number): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const ctx = this.ctx;
    const width = this.camera.width;
    const height = this.camera.height;

    // Reset transform & clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = GRAPH_COLORS.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply DPI scaling
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Render subtle background grid
    this.drawBackgroundGrid(width, height);

    if (!this.model) return;

    // Draw graph elements in logical layers
    this.drawEdges();
    this.drawNodes(now);
    this.drawRacerHeads(now);
    this.drawLabels();
  }

  private drawBackgroundGrid(width: number, height: number): void {
    const ctx = this.ctx;
    // Scale grid step dynamically so dot density stays reasonable at any zoom level
    let step = 80;
    while (step * this.camera.zoom < 25) {
      step *= 2;
    }
    const topLeft = this.camera.screenToWorld({ x: 0, y: 0 });
    const bottomRight = this.camera.screenToWorld({ x: width, y: height });

    const startX = Math.floor(topLeft.x / step) * step;
    const endX = Math.ceil(bottomRight.x / step) * step;
    const startY = Math.floor(topLeft.y / step) * step;
    const endY = Math.ceil(bottomRight.y / step) * step;

    // Dot grid
    ctx.fillStyle = GRAPH_COLORS.grid;
    for (let x = startX; x <= endX; x += step) {
      for (let y = startY; y <= endY; y += step) {
        const s = this.camera.worldToScreen({ x, y });
        ctx.fillRect(s.x - 1, s.y - 1, 2, 2);
      }
    }
  }

  private getRacerColor(racerId: string): string {
    const meta = this.getRacer?.(racerId);
    if (meta) return racerColor(meta.colorIndex);
    const idx = this.model?.racerIds.indexOf(racerId) ?? 0;
    return racerColor(idx >= 0 ? idx : 0);
  }

  private drawEdges(): void {
    if (!this.model) return;
    const ctx = this.ctx;

    // Render edges with additive neon glow pass first, then crisp foreground lines
    for (const edge of this.model.edges.values()) {
      const fromNode = this.sim.nodeById(edge.from);
      const toNode = this.sim.nodeById(edge.to);
      if (!fromNode || !toNode) continue;

      const p1 = this.camera.worldToScreen({ x: fromNode.x, y: fromNode.y });
      const p2 = this.camera.worldToScreen({ x: toNode.x, y: toNode.y });

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;

      const nx = -dy / len;
      const ny = dx / len;

      const entries = Object.entries(edge.counts).filter(([id]) => !this.hiddenRacers.has(id));
      if (!entries.length) continue;

      entries.forEach(([racerId, count], i) => {
        const color = this.getRacerColor(racerId);
        const isDimmed = this.focusedRacerId !== null && this.focusedRacerId !== racerId;
        // Lines scale with the nodes so they don't vanish next to big ones (or dominate small ones).
        const baseWidth = Math.max(1.2, 1.6 * this.camera.zoom) * this.nodeScale;
        // Repeated-edge thickening: circling makes edges noticeably thicker!
        const strokeWidth = Math.max(
          0.8,
          baseWidth + Math.min(count - 1, 6) * 1.3 * this.nodeScale,
        );

        // Offset multi-racer parallel paths slightly perpendicular to edge
        const offsetDist =
          entries.length > 1 ? (i - (entries.length - 1) / 2) * (strokeWidth + 2.5) : 0;
        const ox = nx * offsetDist;
        const oy = ny * offsetDist;

        const x1 = p1.x + ox;
        const y1 = p1.y + oy;
        const x2 = p2.x + ox;
        const y2 = p2.y + oy;

        // Glow pass
        if (!isDimmed) {
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = withAlpha(color, 0.25);
          ctx.lineWidth = strokeWidth * 3.2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        }

        // Crisp pass
        ctx.strokeStyle = isDimmed ? withAlpha(color, 0.12) : color;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Directional arrowhead near the target node
        if (len > 30 * this.nodeScale) {
          // Sits just outside the target disc, so it moves out by however much the scale grew it.
          const toNode = this.model?.nodes.get(edge.to);
          const toHasImage = toNode ? this.readyImage(toNode.id) !== null : false;
          const growth = toNode
            ? this.nodeRadius(toNode, toHasImage) - this.nodeRadius(toNode, toHasImage, 1)
            : 0;
          const arrowDist = 18 * this.camera.zoom + growth;
          const arrowX = x2 - (dx / len) * arrowDist;
          const arrowY = y2 - (dy / len) * arrowDist;
          const arrowSize = Math.max(3, 4.5 * Math.min(this.camera.zoom, 1.5)) * this.nodeScale;

          ctx.fillStyle = isDimmed ? withAlpha(color, 0.2) : color;
          ctx.beginPath();
          ctx.moveTo(arrowX + (dx / len) * arrowSize, arrowY + (dy / len) * arrowSize);
          ctx.lineTo(
            arrowX + nx * arrowSize - (dx / len) * arrowSize,
            arrowY + ny * arrowSize - (dy / len) * arrowSize,
          );
          ctx.lineTo(
            arrowX - nx * arrowSize - (dx / len) * arrowSize,
            arrowY - ny * arrowSize - (dy / len) * arrowSize,
          );
          ctx.closePath();
          ctx.fill();
        }
      });
    }
  }

  private drawNodes(now: number): void {
    if (!this.model) return;
    const ctx = this.ctx;

    for (const node of this.model.nodes.values()) {
      const simNode = this.sim.nodeById(node.id);
      if (!simNode) continue;

      const p = this.camera.worldToScreen({ x: simNode.x, y: simNode.y });
      const img = this.readyImage(node.id);
      const radius = this.nodeRadius(node, img !== null);

      // 1. Target node glowing gold beacon
      if (node.isTarget) {
        const pulse = this.reducedMotion ? 0 : Math.sin(now * 0.004) * 3;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = withAlpha(GRAPH_COLORS.target, 0.35);
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 5 + pulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        this.fillNodeDisc(p, radius, GRAPH_COLORS.nodeFill, img);

        ctx.strokeStyle = GRAPH_COLORS.target;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (node.isStart) {
        // 2. Start node pure white beacon
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = withAlpha(GRAPH_COLORS.start, 0.3);
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        this.fillNodeDisc(p, radius, GRAPH_COLORS.start, img);
        if (img) {
          // The white fill marks the start; with a picture, a white ring does that job instead.
          ctx.strokeStyle = GRAPH_COLORS.start;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      } else {
        // 3. Regular node: dark fill (or thumbnail)
        this.fillNodeDisc(p, radius, GRAPH_COLORS.nodeFill, img);

        // Outer multi-racer segment ring
        const visitors = Object.keys(node.visits).filter((id) => !this.hiddenRacers.has(id));
        if (visitors.length === 0) {
          ctx.strokeStyle = GRAPH_COLORS.nodeIdleRing;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else if (visitors.length === 1) {
          const id = visitors[0]!;
          const color = this.getRacerColor(id);
          const isDim = this.focusedRacerId !== null && this.focusedRacerId !== id;
          ctx.strokeStyle = isDim ? withAlpha(color, 0.2) : color;
          ctx.lineWidth = Math.min(2 + (node.visits[id] ?? 1) * 0.5, 4.5);
          ctx.stroke();
        } else {
          // Multi-visitor segmented circle ring
          const slice = (Math.PI * 2) / visitors.length;
          visitors.forEach((id, idx) => {
            const color = this.getRacerColor(id);
            const isDim = this.focusedRacerId !== null && this.focusedRacerId !== id;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, idx * slice, (idx + 1) * slice);
            ctx.strokeStyle = isDim ? withAlpha(color, 0.2) : color;
            ctx.lineWidth = Math.min(2 + (node.visits[id] ?? 1) * 0.4, 4);
            ctx.stroke();
          });
        }
      }

      // Hover highlight ring (applies to all nodes including start & target)
      if (this.hoveredNode?.id === node.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawRacerHeads(now: number): void {
    if (!this.model) return;
    const ctx = this.ctx;

    for (const [racerId, nodeId] of this.model.heads.entries()) {
      if (this.hiddenRacers.has(racerId)) continue;
      const simNode = this.sim.nodeById(nodeId);
      if (!simNode) continue;

      const p = this.camera.worldToScreen({ x: simNode.x, y: simNode.y });
      const color = this.getRacerColor(racerId);
      const isDim = this.focusedRacerId !== null && this.focusedRacerId !== racerId;

      const racerIdx = this.model.racerIds.indexOf(racerId);
      const phase = racerIdx * 1.1;
      const pulse = this.reducedMotion ? 3 : Math.sin(now * 0.007 + phase) * 3.5 + 4;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = isDim ? withAlpha(color, 0.15) : withAlpha(color, 0.6);
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (14 + pulse) * this.nodeScale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Solid inner racer marker dot
      ctx.fillStyle = isDim ? withAlpha(color, 0.3) : color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5 * this.nodeScale, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawLabels(): void {
    if (!this.model) return;
    const ctx = this.ctx;
    const zoom = this.camera.zoom;

    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (const node of this.model.nodes.values()) {
      const isHead = Array.from(this.model.heads.values()).includes(node.id);
      const isHovered = this.hoveredNode?.id === node.id;
      const isSpecial = node.isStart || node.isTarget || isHead || isHovered;

      // Cull general labels when zoomed out unless prominent/hovered
      if (!isSpecial && (zoom < 0.8 || node.total < 2)) continue;

      const simNode = this.sim.nodeById(node.id);
      if (!simNode) continue;

      const p = this.camera.worldToScreen({ x: simNode.x, y: simNode.y });
      // Labels sit just below the node, so they move out by however much the scale grew it.
      const hasImage = this.readyImage(node.id) !== null;
      const growth =
        this.nodeScale === 1
          ? 0
          : this.nodeRadius(node, hasImage) - this.nodeRadius(node, hasImage, 1);
      const yOffset = (node.isTarget || node.isStart ? 16 : 10) + growth;

      let text = node.id;
      if (node.isTarget) text = `🎯 ${text}`;
      else if (node.isStart) text = `🚀 ${text}`;

      // High contrast label text outline
      ctx.strokeStyle = GRAPH_COLORS.labelOutline;
      ctx.lineWidth = 3.5;
      ctx.strokeText(text, p.x, p.y + yOffset);

      ctx.fillStyle = isSpecial ? GRAPH_COLORS.label : GRAPH_COLORS.labelDim;
      ctx.fillText(text, p.x, p.y + yOffset);
    }
  }

  private setupEventListeners(): void {
    const el = this.canvas;

    el.addEventListener('pointerdown', (e) => {
      this.pointerDownPos = { x: e.offsetX, y: e.offsetY };
      this.lastPointerPos = { x: e.offsetX, y: e.offsetY };
      this.hasMovedDuringDrag = false;
      el.setPointerCapture(e.pointerId);

      const worldPos = this.camera.screenToWorld(this.pointerDownPos);
      const hitNode = nearest(this.sim.nodes, worldPos, this.hitRadiusWorld());

      if (hitNode) {
        this.draggedNodeId = hitNode.id;
        this.sim.pin(hitNode.id, worldPos.x, worldPos.y);
      } else {
        this.isPanning = true;
      }
    });

    el.addEventListener('pointermove', (e) => {
      const current = { x: e.offsetX, y: e.offsetY };
      const dx = current.x - this.lastPointerPos.x;
      const dy = current.y - this.lastPointerPos.y;

      if (Math.hypot(current.x - this.pointerDownPos.x, current.y - this.pointerDownPos.y) > 4) {
        this.hasMovedDuringDrag = true;
      }

      if (this.draggedNodeId) {
        const worldPos = this.camera.screenToWorld(current);
        this.sim.pin(this.draggedNodeId, worldPos.x, worldPos.y);
      } else if (this.isPanning) {
        // Break auto-follow when user manually navigates
        this.followRacerId = null;
        this.camera.panBy(dx, dy);
      } else {
        // Hit-test for hover
        const worldPos = this.camera.screenToWorld(current);
        const nearestNode = nearest(this.sim.nodes, worldPos, this.hitRadiusWorld());
        const node =
          nearestNode && this.model ? (this.model.nodes.get(nearestNode.id) ?? null) : null;

        if (node !== this.hoveredNode) {
          this.hoveredNode = node;
          el.style.cursor = node ? 'pointer' : 'default';
          this.onHover?.(node, node ? current : null);
        }
      }

      this.lastPointerPos = current;
    });

    el.addEventListener('pointerleave', () => {
      if (this.hoveredNode) {
        this.hoveredNode = null;
        el.style.cursor = 'default';
        this.onHover?.(null, null);
      }
    });

    const endPointer = (e: PointerEvent): void => {
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }

      if (this.draggedNodeId) {
        this.sim.unpin(this.draggedNodeId);
        this.draggedNodeId = null;
      }

      if (!this.hasMovedDuringDrag && this.hoveredNode) {
        this.onClick?.(this.hoveredNode);
      }

      this.isPanning = false;
    };

    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.followRacerId = null; // Break auto-follow on manual zoom
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.camera.zoomAt({ x: e.offsetX, y: e.offsetY }, factor);
      },
      { passive: false },
    );

    el.addEventListener('keydown', (e) => {
      const panStep = 40;
      switch (e.key) {
        case 'ArrowUp':
          this.camera.panBy(0, panStep);
          e.preventDefault();
          break;
        case 'ArrowDown':
          this.camera.panBy(0, -panStep);
          e.preventDefault();
          break;
        case 'ArrowLeft':
          if (this.isReplayActive?.()) break;
          this.camera.panBy(panStep, 0);
          e.preventDefault();
          break;
        case 'ArrowRight':
          if (this.isReplayActive?.()) break;
          this.camera.panBy(-panStep, 0);
          e.preventDefault();
          break;
        case '+':
        case '=':
          this.camera.zoomAt({ x: this.camera.width / 2, y: this.camera.height / 2 }, 1.2);
          e.preventDefault();
          break;
        case '-':
        case '_':
          this.camera.zoomAt({ x: this.camera.width / 2, y: this.camera.height / 2 }, 1 / 1.2);
          e.preventDefault();
          break;
        case 'f':
        case 'F':
          this.fitView();
          e.preventDefault();
          break;
      }
    });
  }

  destroy(): void {
    this.isDestroyed = true;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
    }
    this.resizeObserver?.disconnect();
    this.canvas.remove();
  }
}
