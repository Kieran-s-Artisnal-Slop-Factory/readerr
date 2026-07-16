/**
 * DSL autocomplete suggestions (lib/services/dslSuggest.ts), as wired into
 * the capture box: command completion after `!`, and tag/topic name
 * completion inside unclosed `!tags=[` / `!topics=[` values.
 */
import { describe, expect, it } from 'vitest';
import { dslSuggestions } from '../src/lib/services/dslSuggest';

const TAGS = ['rust', 'rendering', 'security'];
const TOPICS = ['history', 'compilers'];

const at = (text: string) => dslSuggestions(text, text.length, TAGS, TOPICS);

describe('command suggestions', () => {
  it('offers tags and topics for !t', () => {
    expect(at('https://a.io !t').map((s) => s.insert)).toEqual(['!tags=[]', '!topics=[]']);
  });

  it('offers everything for a bare !', () => {
    expect(at('https://a.io !').length).toBe(8);
  });

  it('offers priority for !p', () => {
    expect(at('https://a.io !p').map((s) => s.insert)).toEqual(['!priority=']);
  });

  it('narrows by prefix and places the caret inside brackets', () => {
    const [s] = at('https://a.io !ta');
    expect(s.insert).toBe('!tags=[]');
    expect(s.caretOffset).toBe(-1);
    expect(s.start).toBe('https://a.io '.length);
  });

  it('does not trigger inside a URL (! must follow whitespace)', () => {
    expect(at('https://a.io/a!t')).toEqual([]);
  });

  it('does not trigger on a ! at the start of the text', () => {
    expect(at('!')).toEqual([]);
    expect(at('!t')).toEqual([]);
  });

  it('does not trigger on a ! at the start of a line', () => {
    expect(at('https://a.io\n!t')).toEqual([]);
  });
});

describe('value suggestions', () => {
  it('completes tag names by prefix, then substring', () => {
    expect(at('https://a.io !tags=[r').map((s) => s.label)).toEqual([
      'rust',
      'rendering',
      'security', // contains 'r'
    ]);
  });

  it('completes the item after the last comma', () => {
    const [s] = at('https://a.io !tags=[rust, sec');
    expect(s.label).toBe('security');
    expect(s.start).toBe('https://a.io !tags=[rust, '.length);
  });

  it('uses topic names inside !topics=[', () => {
    expect(at('https://a.io !to=[h').map((s) => s.label)).toEqual(['history']);
  });

  it('escapes commas in inserted names', () => {
    const sugg = dslSuggestions('x !tags=[re', 'x !tags=[re'.length, ['really, rusty'], []);
    expect(sugg[0].insert).toBe('really\\, rusty');
  });

  it('stops suggesting once the bracket closes', () => {
    expect(at('https://a.io !tags=[rust]')).toEqual([]);
  });
});
