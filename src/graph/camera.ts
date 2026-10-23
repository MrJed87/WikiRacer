/**
 * Camera maths: world <-> screen, zoom about a point, fit-to-bounds, smoothing. Pure, so it is
 * testable without a canvas. Screen coordinates are CSS pixels with the origin at the top-left.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 5;

export class Camera {
  /** World point shown at the centre of the screen. */
  x = 0;
  y = 0;
  zoom = 1;
  width = 800;
  height = 600;

  setViewport(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  worldToScreen(p: Point): Point {
    return {
      x: (p.x - this.x) * this.zoom + this.width / 2,
      y: (p.y - this.y) * this.zoom + this.height / 2,
    };
  }

  screenToWorld(p: Point): Point {
    return {
      x: (p.x - this.width / 2) / this.zoom + this.x,
      y: (p.y - this.height / 2) / this.zoom + this.y,
    };
  }

  /** Drag by a screen-space delta. */
  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
  }

  /** Zoom keeping the world point under `screen` fixed (wheel and pinch behaviour). */
  zoomAt(screen: Point, factor: number): void {
    const before = this.screenToWorld(screen);
    this.zoom = clampZoom(this.zoom * factor);
    const after = this.screenToWorld(screen);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** The camera that frames `bounds` with padding (screen px). Doesn't move this camera. */
  framing(bounds: Bounds, padding = 60): { x: number; y: number; zoom: number } {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    const zoom = clampZoom(
      Math.min((this.width - padding * 2) / w, (this.height - padding * 2) / h, 1.6),
    );
    return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2, zoom };
  }

  /**
   * Ease towards a target camera. `dtMs` makes it frame-rate independent; `halfLifeMs` is the time
   * to close half the remaining gap. With `instant`, snaps (reduced motion, first frame).
   */
  easeTo(
    target: { x: number; y: number; zoom: number },
    dtMs: number,
    halfLifeMs = 160,
    instant = false,
  ): void {
    const k = instant ? 1 : 1 - 0.5 ** (dtMs / halfLifeMs);
    this.x += (target.x - this.x) * k;
    this.y += (target.y - this.y) * k;
    // Interpolate zoom in log space so zooming feels even.
    this.zoom = clampZoom(
      Math.exp(Math.log(this.zoom) + (Math.log(target.zoom) - Math.log(this.zoom)) * k),
    );
  }
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function boundsOf(points: Iterable<Point>): Bounds | null {
  let b: Bounds | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    b = b
      ? {
          minX: Math.min(b.minX, p.x),
          minY: Math.min(b.minY, p.y),
          maxX: Math.max(b.maxX, p.x),
          maxY: Math.max(b.maxY, p.y),
        }
      : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
  }
  return b;
}

/** Nearest point within `radiusWorld` of `p`, or null. Linear scan: fine for the node counts here. */
export function nearest<T extends Point>(
  items: Iterable<T>,
  p: Point,
  radiusWorld: number,
): T | null {
  let best: T | null = null;
  let bestD = radiusWorld * radiusWorld;
  for (const it of items) {
    const d = (it.x - p.x) ** 2 + (it.y - p.y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}
