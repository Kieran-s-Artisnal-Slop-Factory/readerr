/**
 * Autocomplete for the per-line capture DSL (graduated from the
 * /dsl-auto-complete experiment): given the text and caret position of a
 * capture box, produce the suggestions the caret is asking for —
 * !commands after a bare `!token`, or existing tag/topic names inside an
 * unclosed `!tags=[` / `!topics=[` value. Pure function; the capture box
 * owns the menu UI and insertion.
 */

export interface DslSuggestion {
  /** Menu text (the insertion for commands, the plain name for values). */
  label: string;
  hint: string;
  /** Replacement text for the region [start, caret). */
  insert: string;
  start: number;
  /** Caret lands at start + insert.length + this (-1 = inside `[]`). */
  caretOffset: number;
}

/** Canonical insertion per DSL command (see captureDsl.ts). */
const COMMAND_SUGGESTIONS = [
  { full: 'tags', insert: '!tags=[]', caretOffset: -1, hint: 'comma-separated names, or false' },
  { full: 'topics', insert: '!topics=[]', caretOffset: -1, hint: 'comma-separated names, or false' },
  { full: 'favourite', insert: '!favourite', caretOffset: 0, hint: 'bare = true; =false to clear' },
  { full: 'done', insert: '!done', caretOffset: 0, hint: 'mark read on capture' },
  { full: 'resources', insert: '!resource', caretOffset: 0, hint: 'flag as a resource' },
  { full: 'clean', insert: '!clean=false', caretOffset: 0, hint: 'keep the URL exactly as pasted' },
  { full: 'weeks', insert: '!week=', caretOffset: 0, hint: '0 = this week, 1 = next…, false = none' },
] as const;

export function dslSuggestions(
  text: string,
  caret: number,
  tagNames: string[],
  topicNames: string[]
): DslSuggestion[] {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const before = text.slice(lineStart, caret);

  // Options always FOLLOW a link on their line, so a `!` at the start of
  // the text or of a line is never DSL — suggestions only trigger after a
  // space (this also keeps the menu quiet while typing ordinary text).
  // Inside an unclosed !tags=[ / !topics=[ value: complete existing names.
  const value = before.match(/\s!([A-Za-z]+)=\[((?:\\.|[^\]])*)$/);
  if (value) {
    const w = value[1].toLowerCase();
    const cmd =
      w.startsWith('ta') && 'tags'.startsWith(w) ? 'tags'
      : w.startsWith('to') && 'topics'.startsWith(w) ? 'topics'
      : null;
    if (!cmd) return [];
    // The partial item = everything after the last unescaped comma.
    const partial = (value[2].split(/(?<!\\),/).pop() ?? '').trimStart();
    const start = caret - partial.length;
    const names = cmd === 'tags' ? tagNames : topicNames;
    const q = partial.toLowerCase();
    const starts = names.filter((n) => n.toLowerCase().startsWith(q));
    const contains = q
      ? names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q))
      : [];
    return [...starts, ...contains].slice(0, 8).map((name) => ({
      label: name,
      hint: cmd === 'tags' ? 'existing tag' : 'existing topic',
      insert: name.replace(/,/g, '\\,'),
      start,
      caretOffset: 0,
    }));
  }

  // A bare/partial !command token: offer the commands it could become.
  // Same whitespace rule — a `!` at the very start of the text or line is
  // ordinary text (a link must come first), so it never suggests.
  const cmd = before.match(/\s(![A-Za-z]*)$/);
  if (cmd) {
    const start = caret - cmd[1].length;
    const p = cmd[1].slice(1).toLowerCase();
    return COMMAND_SUGGESTIONS.filter((c) => c.full.startsWith(p)).map((c) => ({
      label: c.insert,
      hint: c.hint,
      insert: c.insert,
      start,
      caretOffset: c.caretOffset,
    }));
  }
  return [];
}
