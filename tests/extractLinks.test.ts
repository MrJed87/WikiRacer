import { describe, expect, it } from 'vitest';
import { decodeEntities, extractPage } from '../src/wiki/extractLinks';
import html from './fixtures/example-town.html?raw';

const base = { linkCap: 150, summaryChars: 600, selfTitle: 'Example Town' };

describe('extractPage', () => {
  it('keeps body links in page order and dedupes', () => {
    const { links } = extractPage(html, base);
    expect(links).toEqual([
      'Infobox Link',
      'Village',
      'Ruritania',
      'Bridge',
      'Jane Doe',
      'River Elbe',
      'Café culture',
      'Zebra',
      'Aardvark',
    ]);
  });

  it('excludes hatnotes, navboxes, references, sidebars, toc, edit links, namespaces, red and external links', () => {
    const { links } = extractPage(html, base);
    for (const bad of [
      'Hatnote City',
      'Reference Only Link',
      'Navbox Link',
      'Sidebar Link',
      'Not Yet Written',
      'History',
    ]) {
      expect(links).not.toContain(bad);
    }
    expect(links.some((l) => l.includes(':'))).toBe(false);
  });

  it('omits self links', () => {
    expect(extractPage(html, base).links).not.toContain('Example Town');
  });

  it('can exclude infobox links', () => {
    const { links } = extractPage(html, { ...base, excludeInfobox: true });
    expect(links).not.toContain('Infobox Link');
    expect(links[0]).toBe('Village');
  });

  it('respects the cap but reports the total', () => {
    const r = extractPage(html, { ...base, linkCap: 3 });
    expect(r.links).toHaveLength(3);
    expect(r.totalLinks).toBe(9);
    expect(r.truncated).toBe(true);
  });

  it('builds a lead summary from body paragraphs only', () => {
    const { summary } = extractPage(html, base);
    expect(summary.startsWith('Example Town is a village in Ruritania.')).toBe(true);
    expect(summary).toContain('1,200 people & one bridge.');
    expect(summary).not.toContain('[1]');
    expect(summary).not.toContain('Founded by');
    expect(summary).not.toContain('For the city');
  });

  it('truncates long summaries at a word boundary with an ellipsis', () => {
    const { summary } = extractPage(html, { ...base, summaryChars: 40 });
    expect(summary.length).toBeLessThanOrEqual(41);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('detects disambiguation pages', () => {
    const d =
      '<div class="dmbox dmbox-disambig"><p>x</p></div><ul><li><a href="/wiki/A">A</a></li></ul>';
    expect(extractPage(d, base).isDisambiguation).toBe(true);
    expect(extractPage(html, base).isDisambiguation).toBe(false);
  });

  it('is tolerant of stray closing tags and empty input', () => {
    expect(extractPage('</div></p><a href="/wiki/X">x</a>', base).links).toEqual(['X']);
    expect(extractPage('', base).links).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities', () => {
    expect(decodeEntities('a&amp;b &#169; &#x41; &nbsp;&unknown;')).toBe('a&b © A  &unknown;');
  });
});
