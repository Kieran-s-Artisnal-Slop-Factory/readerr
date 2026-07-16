/**
 * Per-line capture options (mini DSL): whitespace-separated !options after a
 * pasted link override the capture box UI for that line only.
 *
 *   - [Title](url) !tags=[a, b, with\, comma] !topics=[x] !week=2 !clean=false !done !favourite !resource
 *
 * Commands match by prefix, minimum shown: ta(gs), to(pics), f(avourite),
 * d(one), r(esources), c(lean), w(eeks), p(riority) — case-insensitive.
 * p takes 1 (highest) to 3 (the default for unset links). Booleans accept
 * true/1/yes and false/0/no; a bare flag means true. Arrays are
 * comma-delimited in brackets, items trimmed, `\` escaping the next
 * character (`\,` = a literal comma). tags/topics take an array to MERGE
 * with the UI-selected chips, or false to exclude the selection for that
 * line (an empty array means the same). weeks takes false (no week) or
 * 0–52 (weeks ahead; 0 = the current week).
 *
 * Malformed or unknown options never fail a line — they're collected and
 * surfaced in the capture report while the link still captures.
 */

export interface LineOptions {
  /** Tag names to add on top of the UI selection; false = no tags at all. */
  tags?: string[] | false;
  /** Topic names to add on top of the UI selection; false = no topics. */
  topics?: string[] | false;
  favourite?: boolean;
  done?: boolean;
  resource?: boolean;
  /** Override URL cleaning for this line (true forces it on). */
  clean?: boolean;
  /** Weeks ahead of the current week (0 = this week); false = no week. */
  week?: number | false;
  /** Priority 1 (highest) to 3 (the default for unset links). */
  priority?: number;
}

export interface ParsedLineOptions {
  opts: LineOptions;
  /** Raw tokens that didn't parse — surfaced in the capture report. */
  bad: string[];
}

const MAX_WEEKS_AHEAD = 52;

/** Commands matched by prefix: at least `min`, at most the full word. */
const COMMANDS = [
  { full: 'tags', min: 'ta' },
  { full: 'topics', min: 'to' },
  { full: 'favourite', min: 'f' },
  { full: 'done', min: 'd' },
  { full: 'resources', min: 'r' },
  { full: 'clean', min: 'c' },
  { full: 'weeks', min: 'w' },
  { full: 'priority', min: 'p' },
] as const;
type Command = (typeof COMMANDS)[number]['full'];

function resolveCommand(word: string): Command | null {
  const w = word.toLowerCase();
  for (const c of COMMANDS) {
    if (w.startsWith(c.min) && c.full.startsWith(w)) return c.full;
  }
  return null; // includes the ambiguous bare 't' (tags? topics?)
}

function parseBool(word: string): boolean | null {
  const w = word.toLowerCase();
  if (w === 'true' || w === '1' || w === 'yes') return true;
  if (w === 'false' || w === '0' || w === 'no') return false;
  return null;
}

/** '[a, b\, c]' → ['a', 'b, c']; items trimmed, empties dropped. */
function parseArray(raw: string): string[] {
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let current = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length) {
      current += inner[++i]; // escaped char, taken literally
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);
  return items.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a (bullet-stripped) line into its link part and options text.
 * A markdown link ends at its closing paren; anything else ends at the
 * first whitespace. The remainder only counts as options when it starts
 * with '!' — otherwise the line is returned whole and fails URL parsing
 * exactly as it did before the DSL existed. A '!' inside a URL is safe:
 * options must be whitespace-separated.
 */
export function splitLineOptions(line: string): { link: string; optionsText: string } {
  const md = line.match(/^\[.+\]\(\S+\)/);
  let link: string;
  let rest: string;
  if (md) {
    link = md[0];
    rest = line.slice(md[0].length).trim();
  } else {
    const ws = line.search(/\s/);
    if (ws === -1) return { link: line, optionsText: '' };
    link = line.slice(0, ws);
    rest = line.slice(ws).trim();
  }
  if (!rest.startsWith('!')) return { link: line, optionsText: '' };
  return { link, optionsText: rest };
}

/**
 * Tokens split on whitespace — except inside [...] where spaces belong to
 * the array — with `\` always escorting the next character through.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      current += ch + (text[i + 1] ?? '');
      i++;
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) tokens.push(current);
      current = '';
    } else {
      if (ch === '[') depth++;
      else if (ch === ']' && depth > 0) depth--;
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function parseLineOptions(text: string): ParsedLineOptions {
  const opts: LineOptions = {};
  const bad: string[] = [];
  if (!text) return { opts, bad };

  for (const token of tokenize(text)) {
    const m = token.match(/^!([A-Za-z]+)(?:=([\s\S]*))?$/);
    const cmd = m ? resolveCommand(m[1]) : null;
    if (!cmd) {
      bad.push(token);
      continue;
    }
    const raw = m![2]; // undefined = bare flag

    switch (cmd) {
      case 'tags':
      case 'topics': {
        const key = cmd === 'tags' ? 'tags' : 'topics';
        if (raw !== undefined && raw.startsWith('[') && raw.endsWith(']')) {
          const items = parseArray(raw);
          opts[key] = items.length > 0 ? items : false; // [] = exclude, like false
        } else if (raw !== undefined && parseBool(raw) === false) {
          opts[key] = false;
        } else {
          bad.push(token); // bare !ta / !ta=true have no meaning
        }
        break;
      }
      case 'favourite':
      case 'done':
      case 'resources':
      case 'clean': {
        const value = raw === undefined ? true : parseBool(raw);
        if (value === null) {
          bad.push(token);
        } else if (cmd === 'favourite') {
          opts.favourite = value;
        } else if (cmd === 'done') {
          opts.done = value;
        } else if (cmd === 'resources') {
          opts.resource = value;
        } else {
          opts.clean = value;
        }
        break;
      }
      case 'weeks': {
        // Digits win over the boolean short forms: '0' is week 0 (this
        // week), not false — only the word forms (false/no) opt out.
        if (raw !== undefined && /^\d+$/.test(raw)) {
          if (parseInt(raw, 10) <= MAX_WEEKS_AHEAD) opts.week = parseInt(raw, 10);
          else bad.push(token); // > 52
        } else if (raw !== undefined && parseBool(raw) === false) {
          opts.week = false;
        } else {
          bad.push(token); // bare !w, !w=true, negatives
        }
        break;
      }
      case 'priority': {
        if (raw !== undefined && /^[123]$/.test(raw)) {
          opts.priority = parseInt(raw, 10);
        } else {
          bad.push(token); // bare !p, out-of-range, non-digit
        }
        break;
      }
    }
  }
  return { opts, bad };
}
