/**
 * Title canonicalisation. Pure functions, no DOM.
 *
 * Rules: replace `_` with a space, strip `#fragment`, decode percent-escapes,
 * collapse whitespace. Comparison is case-sensitive *after* resolution; the only case change we make
 * is capitalising the first letter, which is how MediaWiki itself normalises titles on enwiki.
 */
import { WIKI } from '../config';

export function canonicalTitle(raw: string): string {
  let t = raw;
  const hash = t.indexOf('#');
  if (hash !== -1) t = t.slice(0, hash);
  try {
    t = decodeURIComponent(t);
  } catch {
    // Malformed escape sequences: keep the text as-is rather than dropping the link.
  }
  t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

export function sameTitle(a: string, b: string): boolean {
  return canonicalTitle(a) === canonicalTitle(b);
}

/**
 * A valid game link has no namespace prefix, which here means no `:` in the title.
 * That also drops a few real articles ("Star Trek: Voyager"); consistency beats cleverness here.
 */
export function isMainNamespaceTitle(title: string): boolean {
  return title.length > 0 && !title.includes(':');
}

/**
 * Extract a canonical article title from an `href`, or `null` if it's not a valid in-game link.
 * Only site-relative `/wiki/Title` links qualify (external and `/w/index.php?...` links do not).
 */
export function titleFromHref(href: string): string | null {
  if (!href.startsWith('/wiki/')) return null;
  const rest = href.slice('/wiki/'.length);
  // Query strings appear on red links and special pages; neither is a valid destination.
  if (rest.includes('?')) return null;
  const title = canonicalTitle(rest);
  return isMainNamespaceTitle(title) ? title : null;
}

export type ArticleInput = { ok: true; title: string } | { ok: false; reason: string };

/** Language prefix of the configured wiki host, e.g. "en" for en.wikipedia.org. */
const WIKI_LANG = WIKI.host.split('.')[0] ?? 'en';

/**
 * Turns what a person types or pastes into a canonical title. Accepts plain titles and Wikipedia
 * URLs (desktop, mobile, `/w/index.php?title=`), with or without `https://`. A URL for another
 * language edition is rejected rather than silently looked up on the wrong wiki.
 */
export function parseArticleInput(raw: string): ArticleInput {
  const text = raw.trim();
  if (!text) return { ok: false, reason: 'Enter an article title or a Wikipedia link.' };
  if (!/wikipedia\.org/i.test(text) && !/^https?:\/\//i.test(text)) {
    return { ok: true, title: canonicalTitle(text) };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: 'That link could not be read. Paste the article title instead.' };
  }

  const host = url.hostname.toLowerCase();
  const m = /^(?:www\.)?([a-z-]+)(?:\.m)?\.wikipedia\.org$/.exec(host);
  if (!m) return { ok: false, reason: 'Only Wikipedia article links are supported.' };
  if (m[1] !== WIKI_LANG && m[1] !== undefined && host !== 'wikipedia.org') {
    return { ok: false, reason: `Only ${WIKI.host} links are supported (this one is ${host}).` };
  }

  let title: string | null = null;
  if (url.pathname.startsWith('/wiki/')) title = url.pathname.slice('/wiki/'.length);
  else if (url.pathname === '/w/index.php') title = url.searchParams.get('title');
  if (!title) return { ok: false, reason: 'That link does not point to an article.' };

  // URL already percent-decodes nothing in pathname, so canonicalTitle does the decoding.
  const canonical = canonicalTitle(title);
  return canonical
    ? { ok: true, title: canonical }
    : { ok: false, reason: 'That link has no article title.' };
}

/** Best-effort title for code paths that can't show an error (share links, replays). */
export function articleTitleOrRaw(raw: string): string {
  const r = parseArticleInput(raw);
  return r.ok ? r.title : canonicalTitle(raw);
}
