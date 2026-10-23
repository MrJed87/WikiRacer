/**
 * Example replays bundled with the app.
 *
 * Each entry is a real race recorded with the app's own export button. The JSON files load on
 * demand (one small chunk each), so they cost nothing until someone opens one, and they work
 * offline and under the production CSP because nothing is fetched at runtime.
 */
import { validateReplayData, type ReplayData } from '../race/replay';

export interface ExampleReplay {
  /** Stable id, also the JSON file name without its extension. */
  id: string;
  /** Shown in the picker. */
  title: string;
  /** One line on what to watch for. */
  blurb: string;
}

/** In the order they appear in the picker. */
export const EXAMPLE_REPLAYS: readonly ExampleReplay[] = [
  {
    id: 'slipper-lamp-to-amazon-river',
    title: 'Slipper lamp → Amazon River (6 racers)',
    blurb: 'Almost everyone funnels through Egypt and the Nile.',
  },
  {
    id: 'regan-steigleder-to-train',
    title: 'Regan Steigleder → Train (5 flagship models)',
    blurb: 'The most expensive model finishes last.',
  },
  {
    id: 'daydreaming-to-nigeria',
    title: 'Daydreaming (Massive Attack song) → Nigeria (4 racers)',
    blurb: 'Four steps for the fastest, twenty-three for the slowest.',
  },
  {
    id: 'barrage-to-zoology',
    title: 'Barrage (Paul Bley album) → Zoology (4 racers)',
    blurb: 'Shows loop detection and going back.',
  },
  {
    id: 'london-monster-to-john-howard',
    title: 'London Monster → John Howard (5 racers)',
    blurb: 'Two different routes, and one racer that gives up.',
  },
];

const FILES = import.meta.glob<unknown>('./*.json', { import: 'default' });

/** Loads and validates one bundled replay. Throws if the id is unknown or the file is invalid. */
export async function loadExampleReplay(id: string): Promise<ReplayData> {
  const loader = FILES[`./${id}.json`];
  if (!loader) throw new Error(`Unknown example replay "${id}".`);
  return validateReplayData(await loader());
}
