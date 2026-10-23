/**
 * Random well-known target articles. Random pages make poor targets (most are obscure and barely
 * linked), so targets come from Wikipedia's Vital Articles list (about 1,000 core topics), with a
 * built-in list as a fallback if that page can't be read. No DOM.
 */
import type { WikipediaClient } from './client';
import { looksLikeBadStart, validateTarget } from './startPicker';
import { canonicalTitle } from './title';

/** Tried in order; the first that yields a long enough list wins. */
export const VITAL_LIST_PAGES = [
  'Wikipedia:Vital articles/Level/3',
  'Wikipedia:Vital articles/Level 3',
] as const;

/** A real Vital Articles list has about 1,000 entries; fewer means we read the wrong page. */
const MIN_POOL = 200;

/** Well-known, heavily linked topics, used when the Vital Articles list can't be loaded. */
export const FALLBACK_TARGETS: readonly string[] = [
  'Philosophy',
  'Mathematics',
  'Science',
  'Physics',
  'Chemistry',
  'Biology',
  'Astronomy',
  'Moon',
  'Sun',
  'Earth',
  'Water',
  'Fire',
  'Music',
  'Painting',
  'Literature',
  'Poetry',
  'Democracy',
  'Economics',
  'Capitalism',
  'Socialism',
  'Religion',
  'Christianity',
  'Islam',
  'Buddhism',
  'Hinduism',
  'Judaism',
  'Ancient Egypt',
  'Ancient Greece',
  'Roman Empire',
  'Renaissance',
  'Industrial Revolution',
  'World War I',
  'World War II',
  'Cold War',
  'French Revolution',
  'Napoleon',
  'Julius Caesar',
  'Alexander the Great',
  'Genghis Khan',
  'Leonardo da Vinci',
  'William Shakespeare',
  'Isaac Newton',
  'Albert Einstein',
  'Charles Darwin',
  'Galileo Galilei',
  'Aristotle',
  'Plato',
  'Confucius',
  'Karl Marx',
  'Mahatma Gandhi',
  'Abraham Lincoln',
  'Queen Victoria',
  'Wolfgang Amadeus Mozart',
  'Ludwig van Beethoven',
  'Pablo Picasso',
  'Internet',
  'Computer',
  'Electricity',
  'Telephone',
  'Printing press',
  'Wheel',
  'Agriculture',
  'Medicine',
  'Vaccine',
  'Penicillin',
  'DNA',
  'Evolution',
  'Dinosaur',
  'Human',
  'Dog',
  'Cat',
  'Horse',
  'Tree',
  'Rice',
  'Wheat',
  'Coffee',
  'Tea',
  'Association football',
  'Olympic Games',
  'Chess',
  'Film',
  'Television',
  'Africa',
  'Asia',
  'Europe',
  'Australia',
  'Antarctica',
  'Pacific Ocean',
  'Amazon River',
  'Nile',
  'Mount Everest',
  'Sahara',
  'Japan',
  'China',
  'India',
  'Brazil',
  'Canada',
  'Russia',
  'United States',
  'London',
  'Paris',
  'Rome',
  'New York City',
  'Tokyo',
];

export interface TargetPool {
  titles: readonly string[];
  source: 'vital' | 'fallback';
}

type PoolClient = Pick<WikipediaClient, 'linkedArticles'>;
const pools = new WeakMap<object, Promise<TargetPool>>();

/** Loads (once per client) the pool of candidate targets. Never rejects: falls back instead. */
export function loadTargetPool(client: PoolClient): Promise<TargetPool> {
  let pool = pools.get(client);
  if (!pool) {
    pool = (async (): Promise<TargetPool> => {
      for (const page of VITAL_LIST_PAGES) {
        try {
          const titles = [...new Set(await client.linkedArticles(page))].filter(
            (t) => !looksLikeBadStart(t),
          );
          if (titles.length >= MIN_POOL) return { titles, source: 'vital' };
        } catch {
          // Try the next page, then the built-in list.
        }
      }
      return { titles: FALLBACK_TARGETS, source: 'fallback' };
    })();
    pools.set(client, pool);
  }
  return pool;
}

export interface TargetPick {
  title: string;
  incomingLinks: number;
  source: TargetPool['source'];
}

/** A random, validated, well-known target that isn't any of `exclude` (e.g. the start). */
export async function pickRandomTarget(
  client: Pick<WikipediaClient, 'linkedArticles' | 'resolveTitle' | 'incomingLinkCount'>,
  opts: { exclude?: readonly string[]; rng?: () => number; maxAttempts?: number } = {},
): Promise<TargetPick> {
  const rng = opts.rng ?? Math.random;
  const exclude = new Set((opts.exclude ?? []).map(canonicalTitle));
  const pool = await loadTargetPool(client);
  const candidates = pool.titles.filter((t) => !exclude.has(t));
  const tries = Math.min(opts.maxAttempts ?? 5, candidates.length);
  const tried = new Set<string>();
  for (let i = 0; i < tries; i++) {
    let title: string;
    do title = candidates[Math.floor(rng() * candidates.length)]!;
    while (tried.has(title) && tried.size < candidates.length);
    tried.add(title);
    const res = await validateTarget(client, title);
    if (res.ok && !exclude.has(res.title)) {
      return { title: res.title, incomingLinks: res.incomingLinks, source: pool.source };
    }
  }
  throw new Error('Could not pick a random target. Try again or enter one.');
}
