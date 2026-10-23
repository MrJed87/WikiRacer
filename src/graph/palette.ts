/**
 * Every colour used by the graph lives here, so racers stay distinguishable and nothing else hard-codes
 * a colour. Dark background, neon racers.
 * Add new racer colours at the END so existing replays keep their colours.
 */

export const GRAPH_COLORS = {
  background: '#07070d',
  /** Faint dots behind the graph. */
  grid: '#14142a',
  nodeFill: '#0c0c18',
  nodeIdleRing: '#4a4a6a',
  /** The article every racer starts on. */
  start: '#ffffff',
  /** The goal. */
  target: '#ffd23f',
  label: '#e8e8f4',
  labelDim: '#8a8aa8',
  labelOutline: '#07070d',
} as const;

/** One neon colour per racer (up to 6 racers; two spare). Checked for distinctness in tests. */
export const RACER_COLORS = [
  '#00e5ff', // cyan
  '#ff2bd6', // magenta
  '#a6ff00', // lime
  '#ff8a1f', // orange
  '#8c6bff', // violet
  '#ff4d6d', // coral
  '#00ffa3', // mint
  '#4d8dff', // azure
] as const;

export function racerColor(index: number): string {
  const n = RACER_COLORS.length;
  return RACER_COLORS[((index % n) + n) % n] as string;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || m[1] === undefined) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** `rgba(...)` string for a palette colour with the given alpha. */
export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

/** CIELAB distance (deltaE 1976) between two palette colours; used to keep racers distinguishable. */
export function colorDistance(a: string, b: string): number {
  const lab = (hex: string): [number, number, number] => {
    const { r, g, b: bl } = hexToRgb(hex);
    const lin = (v: number): number => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const [R, G, B] = [lin(r), lin(g), lin(bl)] as const;
    const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
