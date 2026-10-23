import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseChoice } from '../src/llm/parseChoice';

const offered = ['Apple', 'Banana', 'Café culture', 'Dates'];

describe('parseChoice: tool arguments', () => {
  it('accepts a 1-based index', () => {
    expect(
      parseChoice({ toolArguments: '{"index": 2, "reason": "fruit"}' }, offered, true),
    ).toEqual({
      kind: 'link',
      title: 'Banana',
      index: 2,
      reason: 'fruit',
    });
  });
  it('accepts a title (canonicalised) and numeric strings', () => {
    expect(
      parseChoice({ toolArguments: '{"title": "Café_culture"}' }, offered, true),
    ).toMatchObject({ kind: 'link', index: 3 });
    expect(parseChoice({ toolArguments: '{"index": "4"}' }, offered, true)).toMatchObject({
      kind: 'link',
      title: 'Dates',
    });
  });
  it('accepts matching index and title', () => {
    expect(
      parseChoice({ toolArguments: '{"index": 1, "title": "Apple"}' }, offered, true),
    ).toMatchObject({ kind: 'link', index: 1 });
  });
  it('rejects disagreeing index and title', () => {
    expect(
      parseChoice({ toolArguments: '{"index": 1, "title": "Dates"}' }, offered, true).kind,
    ).toBe('invalid');
  });
  it('rejects out-of-range, zero, fractional and negative indexes', () => {
    for (const idx of ['0', '5', '1.5', '-1', '"x"', 'true']) {
      expect(parseChoice({ toolArguments: `{"index": ${idx}}` }, offered, true).kind).toBe(
        'invalid',
      );
    }
  });
  it('rejects titles that were not offered (never trust model output)', () => {
    const r = parseChoice({ toolArguments: '{"title": "Cherry"}' }, offered, true);
    expect(r.kind).toBe('invalid');
  });
  it('handles back, only when allowed, including string booleans', () => {
    expect(parseChoice({ toolArguments: '{"back": true}' }, offered, true)).toEqual({
      kind: 'back',
    });
    expect(parseChoice({ toolArguments: '{"back": "true"}' }, offered, true)).toEqual({
      kind: 'back',
    });
    expect(parseChoice({ toolArguments: '{"back": true}' }, offered, false).kind).toBe('invalid');
  });
  it('tolerates wikilink brackets and prefixed numbers', () => {
    expect(parseChoice({ toolArguments: '{"title": "[[Banana]]"}' }, offered, true)).toMatchObject({
      kind: 'link',
      title: 'Banana',
      index: 2,
    });
    expect(parseChoice({ toolArguments: '{"index": "#3"}' }, offered, true)).toMatchObject({
      kind: 'link',
      index: 3,
    });
  });
  it('rejects empty objects, bad JSON and empty replies', () => {
    expect(parseChoice({ toolArguments: '{}' }, offered, true).kind).toBe('invalid');
    expect(parseChoice({ toolArguments: 'not json' }, offered, true).kind).toBe('invalid');
    expect(parseChoice({ content: '   ' }, offered, true).kind).toBe('invalid');
    expect(parseChoice({}, offered, true).kind).toBe('invalid');
  });
  it('tolerates slightly broken argument JSON with surrounding text', () => {
    expect(parseChoice({ toolArguments: 'Sure! {"index": 3} done' }, offered, true)).toMatchObject({
      kind: 'link',
      index: 3,
    });
  });
  it('truncates and trims reasons', () => {
    const r = parseChoice(
      { toolArguments: JSON.stringify({ index: 1, reason: `  ${'x'.repeat(1000)} ` }) },
      offered,
      true,
    );
    expect(r.kind === 'link' && r.reason?.length).toBe(300);
  });
  it('never offers a choice when there are no links', () => {
    expect(parseChoice({ toolArguments: '{"index": 1}' }, [], true).kind).toBe('invalid');
  });
});

describe('parseChoice: JSON fallback from content', () => {
  it('parses a bare JSON object', () => {
    expect(parseChoice({ content: '{"index": 4}' }, offered, true)).toMatchObject({
      kind: 'link',
      title: 'Dates',
    });
  });
  it('parses fenced JSON with prose around it', () => {
    const content =
      'I think this is best.\n```json\n{"index": 2, "reason": "has {braces} in it"}\n```\nGood luck';
    expect(parseChoice({ content }, offered, true)).toMatchObject({
      kind: 'link',
      index: 2,
      reason: 'has {braces} in it',
    });
  });
  it('prefers the tool call over content', () => {
    expect(
      parseChoice({ toolArguments: '{"index": 1}', content: '{"index": 2}' }, offered, true),
    ).toMatchObject({ index: 1 });
  });
  it('rejects prose without JSON', () => {
    expect(parseChoice({ content: 'I choose Banana.' }, offered, true).kind).toBe('invalid');
  });
});

describe('extractJsonObject', () => {
  it('skips invalid braces and finds the next valid object', () => {
    expect(extractJsonObject('{oops} then {"a": 1}')).toEqual({ a: 1 });
  });
  it('returns undefined when nothing parses', () => {
    expect(extractJsonObject('no braces')).toBeUndefined();
    expect(extractJsonObject('{"a": ')).toBeUndefined();
  });
});
