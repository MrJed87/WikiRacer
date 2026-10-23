import { describe, expect, it } from 'vitest';
import { canonicalTitle, isMainNamespaceTitle, sameTitle, titleFromHref } from '../src/wiki/title';

describe('canonicalTitle', () => {
  it('replaces underscores, strips fragments and trims', () => {
    expect(canonicalTitle('  River_Elbe#Course ')).toBe('River Elbe');
  });
  it('decodes percent escapes', () => {
    expect(canonicalTitle('Caf%C3%A9_culture')).toBe('Café culture');
  });
  it('survives malformed escapes', () => {
    expect(canonicalTitle('100%_sure')).toBe('100% sure');
  });
  it('capitalises the first letter only', () => {
    expect(canonicalTitle('iPhone_Pro')).toBe('IPhone Pro');
    expect(canonicalTitle('Example_Town')).toBe('Example Town');
  });
  it('collapses repeated whitespace', () => {
    expect(canonicalTitle('A__B   C')).toBe('A B C');
  });
  it('compares case-sensitively after canonicalisation', () => {
    expect(sameTitle('example_Town', 'Example Town')).toBe(true);
    expect(sameTitle('Example Town', 'Example town')).toBe(false);
  });
});

describe('titleFromHref', () => {
  it('accepts plain article links', () => {
    expect(titleFromHref('/wiki/Bridge#History')).toBe('Bridge');
  });
  it('rejects namespaces, external, query and empty links', () => {
    expect(titleFromHref('/wiki/Category:Villages')).toBeNull();
    expect(titleFromHref('/wiki/File:Pic.jpg')).toBeNull();
    expect(titleFromHref('https://example.com/')).toBeNull();
    expect(titleFromHref('/w/index.php?title=X&action=edit')).toBeNull();
    expect(titleFromHref('/wiki/Foo?action=edit')).toBeNull();
    expect(titleFromHref('#cite_note-1')).toBeNull();
    expect(titleFromHref('/wiki/')).toBeNull();
  });
  it('flags namespace titles', () => {
    expect(isMainNamespaceTitle('Help:Contents')).toBe(false);
    expect(isMainNamespaceTitle('Bridge')).toBe(true);
  });
});
