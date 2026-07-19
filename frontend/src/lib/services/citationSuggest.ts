/**
 * Autocomplete for topic citations, the `[^n]` counterpart to the capture
 * box's DSL completion (see dslSuggest.ts): given the text and caret
 * position of a document being edited, produce the links the caret is
 * asking for. Pure function; the editor owns the menu UI and insertion.
 *
 * The topic's own references rank first — those already have a number.
 * Below them come the rest of the library, so a link can be cited without
 * leaving the editor to file it under the topic first; accepting one of
 * those is what assigns it and issues its number (the editor's job).
 */
import { domainOf } from './links';
import type { Link } from '../db/types';
import type { TopicReference } from './topics';

export interface CitationSuggestion {
  /** The link being offered. */
  link: Link;
  /** Its footnote number, or null when it isn't on this topic yet. */
  number: number | null;
  /** Menu text. */
  label: string;
  hint: string;
  /** Replacement region for the insertion: [start, caret). */
  start: number;
}

/**
 * The trigger: `[^` plus what's been typed since, up to the caret. The
 * backslash is optional because the WYSIWYG editor escapes the bracket on
 * save, so source mode can be looking at `\[^…` (see topicExport.ts).
 *
 * A query stops at `]` (the citation is already closed — nothing to
 * complete) or a newline, and is capped so a stray `[^` earlier in a
 * paragraph can't keep the menu open for the rest of the line.
 */
const TRIGGER = /\\?\[\^([^\]\n]{0,40})$/;

const MAX_SUGGESTIONS = 8;

export function citationSuggestions(
  text: string,
  caret: number,
  refs: TopicReference[],
  allLinks: Link[]
): CitationSuggestion[] {
  const match = TRIGGER.exec(text.slice(0, caret));
  if (!match) return [];

  const query = match[1].trim().toLowerCase();
  const start = caret - match[0].length;

  // An all-digits query is the citation you already know the number of —
  // match numbers ONLY, or `[^3` also drags in every link with a 3
  // somewhere in its URL. Anything else is a title/URL search.
  const numeric = /^\d+$/.test(query);
  const matches = (link: Link, number: number | null): boolean => {
    if (!query) return true;
    if (numeric) return number !== null && String(number).startsWith(query);
    return link.title.toLowerCase().includes(query) || link.url.toLowerCase().includes(query);
  };

  const assigned = new Set(refs.map((r) => r.link.id));

  const cited: CitationSuggestion[] = refs
    .filter((r) => matches(r.link, r.number))
    .map((r) => ({
      link: r.link,
      number: r.number,
      label: r.link.title,
      hint: domainOf(r.link.url),
      start,
    }));

  // Fill the rest of the menu from the library — never a link already
  // cited above, and only once the reference list has been offered.
  const room = MAX_SUGGESTIONS - Math.min(cited.length, MAX_SUGGESTIONS);
  const uncited: CitationSuggestion[] =
    room <= 0
      ? []
      : allLinks
          .filter((l) => !assigned.has(l.id) && !l.deleted_at && matches(l, null))
          .sort((a, b) => b.added_at.localeCompare(a.added_at))
          .slice(0, room)
          .map((link) => ({
            link,
            number: null,
            label: link.title,
            hint: domainOf(link.url),
            start,
          }));

  return [...cited.slice(0, MAX_SUGGESTIONS), ...uncited];
}

/** The text a chosen suggestion inserts, once its number is known. */
export function citationText(number: number): string {
  return `[^${number}]`;
}
