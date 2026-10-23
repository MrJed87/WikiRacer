/**
 * Link and lead-summary extraction from MediaWiki `action=parse` HTML.
 *
 * Deliberately a tiny dependency-free tokenizer rather than DOMParser: this layer must run in
 * Node without a DOM, and never building a DOM from untrusted HTML keeps it inert. MediaWiki's parser
 * output is well-formed, so tracking an element stack is sufficient.
 */
import { titleFromHref } from './title';

export interface ExtractOptions {
  /** Max links to return. Extra links are dropped but still counted in `totalLinks`. */
  linkCap: number;
  /** Max characters of lead text. */
  summaryChars: number;
  /** Title of the page being scanned; self-links are omitted. */
  selfTitle?: string;
  /** Infobox links are valid page links, so they're kept unless this is set. */
  excludeInfobox?: boolean;
}

export interface ExtractedPage {
  /** Canonical titles, in page order, deduped, capped. */
  links: string[];
  /** Number of distinct valid links before the cap. */
  totalLinks: number;
  truncated: boolean;
  summary: string;
  isDisambiguation: boolean;
}

/** Blocks that are page furniture rather than article body (navboxes, references, hatnotes, sidebars and similar). */
const EXCLUDED_CLASSES = new Set([
  'navbox',
  'navbox-styles',
  'vertical-navbox',
  'reflist',
  'references',
  'mw-references-wrap',
  'refbegin',
  'reference',
  'hatnote',
  'mw-editsection',
  'sidebar',
  'metadata',
  'ambox',
  'dmbox',
  'toc',
  'printfooter',
  'catlinks',
  'noprint',
]);

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      return code === 160 ? ' ' : String.fromCodePoint(code);
    }
    return ENTITY_MAP[body.toLowerCase()] ?? match;
  });
}

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1];
    if (name === undefined) continue;
    attrs.set(name.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function classesOf(attrs: Map<string, string>): string[] {
  return (attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
}

interface OpenElement {
  name: string;
  excluded: boolean;
}

export function extractPage(html: string, opts: ExtractOptions): ExtractedPage {
  // Style/script bodies and comments contain `<` text that would confuse the scanner.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, '');

  const isDisambiguation = /class\s*=\s*["'][^"']*\b(dmbox-disambig|disambigbox)\b/i.test(cleaned);
  const self = opts.selfTitle;

  const stack: OpenElement[] = [];
  let excludedDepth = 0;
  const seen = new Set<string>();
  const links: string[] = [];

  // Lead summary state: text of leading body paragraphs, until the first section heading.
  let leadDone = false;
  const leadParts: string[] = [];
  let paraText = '';
  let paraDepthOk = false;
  let leadLength = 0;

  const paragraphAllowed = (): boolean =>
    excludedDepth === 0 &&
    !stack.some((e) => e.name === 'table' || e.name === 'li' || e.name === 'blockquote');

  const popTo = (name: string): void => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i]?.name === name) {
        while (stack.length > i) {
          const el = stack.pop();
          if (el?.excluded) excludedDepth--;
        }
        return;
      }
    }
    // Stray closing tag: ignore.
  };

  let cursor = 0;
  for (const m of cleaned.matchAll(TAG_RE)) {
    const index = m.index ?? 0;
    // Text node between the previous tag and this one.
    if (index > cursor && !leadDone && paraDepthOk && excludedDepth === 0) {
      paraText += cleaned.slice(cursor, index);
    }
    cursor = index + m[0].length;

    const closing = m[1] === '/';
    const name = (m[2] ?? '').toLowerCase();
    const rawAttrs = m[3] ?? '';

    if (closing) {
      if (name === 'p' && paraDepthOk) {
        const text = decodeEntities(paraText).replace(/\s+/g, ' ').trim();
        if (text.length > 0 && !leadDone) {
          leadParts.push(text);
          leadLength += text.length;
          if (leadLength >= opts.summaryChars) leadDone = true;
        }
        paraText = '';
        paraDepthOk = false;
      }
      popTo(name);
      continue;
    }

    const attrs = parseAttrs(rawAttrs);
    const classes = classesOf(attrs);
    const selfClosing = rawAttrs.trimEnd().endsWith('/');

    if (/^h[1-6]$/.test(name) && !leadDone && leadParts.length > 0) {
      // First heading after real lead text ends the lead.
      leadDone = true;
    }

    if (name === 'a' && excludedDepth === 0) {
      const href = attrs.get('href');
      // `new` marks a red link (page doesn't exist), which is a dead end.
      if (href !== undefined && !classes.includes('new') && !classes.includes('external')) {
        const title = titleFromHref(href);
        if (title !== null && title !== self && !seen.has(title)) {
          seen.add(title);
          if (links.length < opts.linkCap) links.push(title);
        }
      }
    }

    if (VOID_TAGS.has(name) || selfClosing) continue;

    const excluded =
      classes.some((c) => EXCLUDED_CLASSES.has(c)) ||
      (opts.excludeInfobox === true && classes.includes('infobox')) ||
      attrs.get('role') === 'navigation';
    stack.push({ name, excluded });
    if (excluded) excludedDepth++;

    if (name === 'p' && !leadDone && paragraphAllowed() && !classes.includes('mw-empty-elt')) {
      paraDepthOk = true;
      paraText = '';
    }
  }

  let summary = leadParts.join(' ');
  if (summary.length > opts.summaryChars) {
    const cut = summary.slice(0, opts.summaryChars);
    const lastSpace = cut.lastIndexOf(' ');
    summary = (lastSpace > opts.summaryChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
  }

  return {
    links,
    totalLinks: seen.size,
    truncated: seen.size > links.length,
    summary,
    isDisambiguation,
  };
}
