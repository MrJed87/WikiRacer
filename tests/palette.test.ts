import { describe, expect, it } from 'vitest';
import {
  GRAPH_COLORS,
  RACER_COLORS,
  colorDistance,
  hexToRgb,
  racerColor,
  withAlpha,
} from '../src/graph/palette';

describe('palette', () => {
  it('has 6+ racer colours, all valid hex', () => {
    expect(RACER_COLORS.length).toBeGreaterThanOrEqual(6);
    for (const c of [...RACER_COLORS, ...Object.values(GRAPH_COLORS)])
      expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('keeps racer colours distinguishable from each other, the start, the target and the background', () => {
    const colors = RACER_COLORS.slice(0, 6);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(
          colorDistance(colors[i] as string, colors[j] as string),
          `${colors[i]} vs ${colors[j]}`,
        ).toBeGreaterThan(30);
      }
      expect(
        colorDistance(colors[i] as string, GRAPH_COLORS.target),
        `${colors[i]} vs target`,
      ).toBeGreaterThan(30);
      expect(colorDistance(colors[i] as string, GRAPH_COLORS.start)).toBeGreaterThan(30);
      expect(colorDistance(colors[i] as string, GRAPH_COLORS.background)).toBeGreaterThan(40);
    }
  });

  it('wraps racer indexes and converts colours', () => {
    expect(racerColor(0)).toBe(RACER_COLORS[0]);
    expect(racerColor(RACER_COLORS.length)).toBe(RACER_COLORS[0]);
    expect(racerColor(-1)).toBe(RACER_COLORS[RACER_COLORS.length - 1]);
    expect(hexToRgb('#ff8000')).toEqual({ r: 255, g: 128, b: 0 });
    expect(withAlpha('#ff8000', 0.5)).toBe('rgba(255, 128, 0, 0.5)');
    expect(withAlpha('#ff8000', 7)).toBe('rgba(255, 128, 0, 1)');
    expect(() => hexToRgb('red')).toThrow();
  });
});
