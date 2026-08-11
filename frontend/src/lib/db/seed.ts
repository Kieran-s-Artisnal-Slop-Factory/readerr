/**
 * Demo + stress-test data seeding. Two knobs drive the volume (`linksPerWeek`
 * and `weeks`); everything else — how many tags exist and how lopsidedly they
 * are used, how deep the tag hierarchy goes, how many topics cite how many
 * links, what share of links end up favourited / resourced / slushed /
 * archived, how much prose hangs off them — is an explicit control so you can
 * shape a dataset that stresses the exact page you care about.
 *
 * Content is nonsense; the point is realistic *volume and shape*. Generation
 * is deterministic (seeded PRNG) and every row goes through the normal stores,
 * so seeded data syncs like real data. Repeated runs add duplicates (fresh ids
 * each run) — seed onto a fresh install.
 *
 * **Percentages are exact, not probabilistic.** "12% favourites" samples
 * exactly round(links * 0.12) distinct links rather than flipping a coin per
 * link, so a control you set is a control you can measure. Where two controls
 * fight (slush needs a read link; a tail tag can't have more links than exist)
 * the physical limit wins and the returned SeedSummary reports what was
 * actually written.
 */
import { bulkPut, withSyncFields } from './repo';
import { weekStartPlus, currentWeekStart } from '../services/weeks';
import { archiveNow } from '../services/archive';
import { saveUserSettings } from '../services/settings';
import { MAX_TAG_DEPTH } from '../services/tagTree';
import type {
  Excerpt,
  Link,
  LinkTag,
  LinkTopic,
  Note,
  ResourceList,
  ResourceListLink,
  Tag,
  TagParent,
  Topic,
  Week,
  WeekLink,
} from './types';

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLE_WORDS = [
  'B-Trees explained',
  'WAL deep dive',
  'Postgres locks',
  'SQLite internals',
  'Query planning',
  'MVCC in practice',
  'Go error handling',
  'Goroutine patterns',
  'pprof profiling',
  'Generics in Go',
  'Table-driven tests',
  'HTMX vs SPA',
  'CSS container queries',
  'Astro islands',
  'Service worker caching',
  'View transitions',
  'Local-first sync',
  'Attention explained',
  'RAG pipelines',
  'Tokenizers by hand',
  'Eval harnesses',
  'Quantization tricks',
  'PCB fabrication',
  'Wi-Fi 7 explained',
  'Keyboard firmware',
  'SSD internals',
  'RISC-V boards',
] as const;

/** Real hosts first — beyond these the pool is synthesised (see originName). */
const REAL_HOSTS = [
  'youtube.com',
  'sqlite.org',
  'go.dev',
  'developer.mozilla.org',
  'arxiv.org',
  'simonwillison.net',
  'news.ycombinator.com',
  'github.com',
  'planetscale.com',
  'brooker.co.za',
  'muratbuffalo.blogspot.com',
  'threedots.tech',
  'lesiw.dev',
  'titpetric.com',
  'astro.build',
  'kieranwood.ca',
  'joshwcomeau.com',
  'huggingface.co',
  'byhand.ai',
  'hackaday.com',
  'anandtech.com',
  'ieee.org',
  'lwn.net',
  'rachelbythebay.com',
] as const;

const HOST_WORDS = [
  'byte',
  'stack',
  'kernel',
  'lambda',
  'proto',
  'quanta',
  'signal',
  'vector',
  'cadence',
  'foundry',
  'lattice',
  'meridian',
  'orbital',
  'pixel',
  'runtime',
  'sandbox',
  'thicket',
  'umbra',
  'vellum',
  'wharf',
] as const;

const HOST_TLDS = ['com', 'dev', 'io', 'net', 'org', 'blog'] as const;

const TAG_WORDS = [
  'databases',
  'go',
  'webdev',
  'ai',
  'hardware',
  'security',
  'linux',
  'rust',
  'design',
  'career',
  'distributed',
  'graphics',
  'networking',
  'observability',
  'compilers',
  'testing',
  'product',
  'writing',
  'privacy',
  'embedded',
] as const;

const TAG_QUALIFIERS = [
  'internals',
  'patterns',
  'tooling',
  'perf',
  'testing',
  'ops',
  'theory',
  'history',
  'notes',
  'reading',
] as const;

/** Sentence pool for generated prose — nonsense, but the right shape. */
const SENTENCES = [
  'The interesting failure modes cluster around the edges: retries, partial writes, and clocks.',
  'Most of the cost turned out to be in the serialisation, not the transport.',
  'Worth revisiting once the numbers settle down.',
  'The benchmark is misleading unless you pin the cache behaviour first.',
  'Two devices, each offline, will happily disagree until something reconciles them.',
  'A smaller working set beat a cleverer index every time.',
  'The API is fine; the defaults are the problem.',
  'See the referenced links for worked examples.',
  'This is the third time this pattern has come up, so it is probably real.',
  'It degrades gracefully, which matters more here than being fast.',
  'The migration path is the hard part, as usual.',
  'Rough notes accumulated over several reads.',
  'Nothing here is novel, but the framing is unusually clear.',
  'Skip the first half; the second half is the actual argument.',
] as const;

/** How many sentences make a paragraph, for the prose-length controls. */
const SENTENCES_PER_PARAGRAPH = 5;

/**
 * A prose length range, expressed the way you'd describe it out loud:
 * "at least one sentence, at most twelve paragraphs".
 */
export interface ProseLength {
  /** Shortest body, in sentences. */
  minSentences: number;
  /** Longest body, in paragraphs. */
  maxParagraphs: number;
}

export interface TagSeedOptions {
  /** How many tags to create. Names are unique, so none get merged on read. */
  count: number;
  /** Size of the "top" group whose share you're pinning (0–5). */
  topCount: number;
  /** Percentage of all tag assignments the top group accounts for. */
  topSharePct: number;
  /** Ceiling for every other tag, as a percentage of total links. */
  tailMaxSharePct: number;
  /** Average tags per link — sets the total number of assignments. */
  tagsPerLink: number;
  /** Percentage of tags that get an about/description section. */
  describedPct: number;
  descriptionLength: ProseLength;
  /** Nesting depth of the generated tag DAG; 1 = flat, no edges. */
  maxDepth: number;
  /** Percentage of tags nested under at least one parent. */
  nestedPct: number;
  /** Average parents per nested tag; above 1 makes it a DAG, not a tree. */
  parentsPerTag: number;
}

export interface TopicSeedOptions {
  /** How many topics to create; null scales with usage as it always has. */
  count: number | null;
  /** Size of the "top" group whose share of references you're pinning (0–5). */
  topCount: number;
  /** Percentage of all references the top group accounts for. */
  topSharePct: number;
  /** Total references to create, as a percentage of total links. */
  referencesPct: number;
  /** Bounds on a single topic's reference count. */
  minRefs: number;
  maxRefs: number;
  /** Percentage of topics that get a body/description document. */
  describedPct: number;
  descriptionLength: ProseLength;
}

export interface LinkSeedOptions {
  /** Percentage of links carrying a note document. */
  notesPct: number;
  notesLength: ProseLength;
  /** Percentage of links carrying at least one excerpt. */
  excerptsPct: number;
  excerptLength: ProseLength;
  /** Percentage of links re-scheduled into a later week as a review. */
  reviewedPct: number;
}

export interface ArchiveSeedOptions {
  /** Turn yearly archival on and run it once the data is written. */
  enabled: boolean;
  /** Slushed links older than this many months get archived. */
  afterMonths: number;
}

export interface SeedOptions {
  /** Capture rate; the demo default is 20. */
  linksPerWeek: number;
  /** How far back to generate; 52 per year. */
  weeks: number;
  /** Size of the domain pool links are drawn from. */
  origins?: number;
  /** Percentage of links flagged favourite. */
  favouritePct?: number;
  /** Percentage of links flagged as a resource. */
  resourcePct?: number;
  /** Percentage of links that end up in the slush (capped by how many read). */
  slushPct?: number;
  tags?: Partial<TagSeedOptions>;
  topics?: Partial<TopicSeedOptions>;
  links?: Partial<LinkSeedOptions>;
  archive?: Partial<ArchiveSeedOptions>;
}

export interface SeedSummary {
  links: number;
  weeks: number;
  origins: number;
  tags: number;
  /** tag_parents edges written. */
  tagEdges: number;
  tagAssignments: number;
  topics: number;
  /** link_topics rows written. */
  references: number;
  notes: number;
  excerpts: number;
  favourites: number;
  resources: number;
  slushed: number;
  /** week_links rows with kind 'review'. */
  reviews: number;
  /** Links moved into the local-only archive (0 unless archival was on). */
  archived: number;
}

/** Defaults — a small, friendly demo library. */
export const DEFAULT_SEED_OPTIONS: {
  origins: number;
  favouritePct: number;
  resourcePct: number;
  slushPct: number;
  tags: TagSeedOptions;
  topics: TopicSeedOptions;
  links: LinkSeedOptions;
  archive: ArchiveSeedOptions;
} = {
  origins: 18,
  favouritePct: 2,
  resourcePct: 3,
  slushPct: 70,
  tags: {
    count: 5,
    topCount: 3,
    topSharePct: 60,
    tailMaxSharePct: 25,
    tagsPerLink: 0.8,
    describedPct: 40,
    descriptionLength: { minSentences: 2, maxParagraphs: 2 },
    maxDepth: 2,
    nestedPct: 25,
    parentsPerTag: 1,
  },
  topics: {
    count: null,
    topCount: 3,
    topSharePct: 40,
    referencesPct: 2,
    minRefs: 1,
    maxRefs: 40,
    describedPct: 100,
    descriptionLength: { minSentences: 6, maxParagraphs: 6 },
  },
  links: {
    notesPct: 8,
    notesLength: { minSentences: 3, maxParagraphs: 2 },
    excerptsPct: 3,
    excerptLength: { minSentences: 1, maxParagraphs: 1 },
    reviewedPct: 5,
  },
  archive: { enabled: false, afterMonths: 24 },
};

export interface ResolvedSeedOptions {
  linksPerWeek: number;
  weeks: number;
  origins: number;
  favouritePct: number;
  resourcePct: number;
  slushPct: number;
  tags: TagSeedOptions;
  topics: TopicSeedOptions & { count: number };
  links: LinkSeedOptions;
  archive: ArchiveSeedOptions;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(n)));
const pct = (n: number): number => Math.max(0, Math.min(100, n));

function proseLength(over: Partial<ProseLength> | undefined, base: ProseLength): ProseLength {
  return {
    minSentences: clamp(over?.minSentences ?? base.minSentences, 1, 500),
    maxParagraphs: clamp(over?.maxParagraphs ?? base.maxParagraphs, 1, 100),
  };
}

/**
 * Fill in defaults and clamp everything into range. Exported so the settings
 * panel can show the numbers a run will actually use (topic count in
 * particular is derived from usage unless you pin it).
 */
export function resolveSeedOptions(options: SeedOptions): ResolvedSeedOptions {
  const linksPerWeek = clamp(options.linksPerWeek, 1, 500);
  const weeks = clamp(options.weeks, 1, 1040);
  const d = DEFAULT_SEED_OPTIONS;
  const t = options.tags ?? {};
  const tp = options.topics ?? {};
  const lk = options.links ?? {};
  const ar = options.archive ?? {};

  // The historical rule: topics scale with usage against a 150-links/week
  // baseline. Kept as the "auto" value so an unchanged run looks like it always did.
  const autoTopics = Math.max(1, Math.round(3 * (linksPerWeek / 150) * weeks));

  const minRefs = clamp(tp.minRefs ?? d.topics.minRefs, 0, 100_000);
  return {
    linksPerWeek,
    weeks,
    origins: clamp(options.origins ?? d.origins, 1, 5000),
    favouritePct: pct(options.favouritePct ?? d.favouritePct),
    resourcePct: pct(options.resourcePct ?? d.resourcePct),
    slushPct: pct(options.slushPct ?? d.slushPct),
    tags: {
      count: clamp(t.count ?? d.tags.count, 0, 10_000),
      topCount: clamp(t.topCount ?? d.tags.topCount, 0, 5),
      topSharePct: pct(t.topSharePct ?? d.tags.topSharePct),
      tailMaxSharePct: pct(t.tailMaxSharePct ?? d.tags.tailMaxSharePct),
      tagsPerLink: Math.max(0, Math.min(20, t.tagsPerLink ?? d.tags.tagsPerLink)),
      describedPct: pct(t.describedPct ?? d.tags.describedPct),
      descriptionLength: proseLength(t.descriptionLength, d.tags.descriptionLength),
      maxDepth: clamp(t.maxDepth ?? d.tags.maxDepth, 1, MAX_TAG_DEPTH),
      nestedPct: pct(t.nestedPct ?? d.tags.nestedPct),
      parentsPerTag: Math.max(1, Math.min(5, t.parentsPerTag ?? d.tags.parentsPerTag)),
    },
    topics: {
      count: clamp(tp.count ?? autoTopics, 0, 100_000),
      topCount: clamp(tp.topCount ?? d.topics.topCount, 0, 5),
      topSharePct: pct(tp.topSharePct ?? d.topics.topSharePct),
      referencesPct: Math.max(0, Math.min(500, tp.referencesPct ?? d.topics.referencesPct)),
      minRefs,
      maxRefs: Math.max(minRefs, clamp(tp.maxRefs ?? d.topics.maxRefs, 0, 100_000)),
      describedPct: pct(tp.describedPct ?? d.topics.describedPct),
      descriptionLength: proseLength(tp.descriptionLength, d.topics.descriptionLength),
    },
    links: {
      notesPct: pct(lk.notesPct ?? d.links.notesPct),
      notesLength: proseLength(lk.notesLength, d.links.notesLength),
      excerptsPct: pct(lk.excerptsPct ?? d.links.excerptsPct),
      excerptLength: proseLength(lk.excerptLength, d.links.excerptLength),
      reviewedPct: pct(lk.reviewedPct ?? d.links.reviewedPct),
    },
    archive: {
      enabled: ar.enabled ?? d.archive.enabled,
      afterMonths: clamp(ar.afterMonths ?? d.archive.afterMonths, 1, 600),
    },
  };
}

/** Unique tag name for index i — uniqueness matters, or reconcileTags merges them. */
function tagName(i: number): string {
  if (i < TAG_WORDS.length) return TAG_WORDS[i];
  const word = TAG_WORDS[i % TAG_WORDS.length];
  const qualifier = TAG_QUALIFIERS[Math.floor(i / TAG_WORDS.length) % TAG_QUALIFIERS.length];
  const cycle = Math.floor(i / (TAG_WORDS.length * TAG_QUALIFIERS.length));
  return cycle === 0 ? `${word}-${qualifier}` : `${word}-${qualifier}-${cycle + 1}`;
}

/** Unique hostname for index i: the real pool first, then synthesised. */
function originName(i: number): string {
  if (i < REAL_HOSTS.length) return REAL_HOSTS[i];
  const n = i - REAL_HOSTS.length;
  const word = HOST_WORDS[n % HOST_WORDS.length];
  const tld = HOST_TLDS[Math.floor(n / HOST_WORDS.length) % HOST_TLDS.length];
  const cycle = Math.floor(n / (HOST_WORDS.length * HOST_TLDS.length));
  return cycle === 0 ? `${word}.${tld}` : `${word}${cycle + 1}.${tld}`;
}

function prose(rand: () => number, len: ProseLength, heading?: string): string {
  const min = len.minSentences;
  const max = Math.max(min, len.maxParagraphs * SENTENCES_PER_PARAGRAPH);
  const total = min + Math.floor(rand() * (max - min + 1));
  const paragraphs: string[] = [];
  for (let i = 0; i < total; i += SENTENCES_PER_PARAGRAPH) {
    const chunk: string[] = [];
    for (let j = i; j < Math.min(i + SENTENCES_PER_PARAGRAPH, total); j++) {
      chunk.push(SENTENCES[Math.floor(rand() * SENTENCES.length)]);
    }
    paragraphs.push(chunk.join(' '));
  }
  return (heading ? `# ${heading}\n\n` : '') + paragraphs.join('\n\n');
}

/**
 * `count` distinct indices from [0, poolSize). Rejection sampling while the
 * ask is small relative to the pool; past half the pool it samples the
 * complement instead, so "95% of links" is as cheap as "5%".
 */
function sampleIndices(count: number, poolSize: number, rand: () => number): number[] {
  const n = Math.max(0, Math.min(Math.round(count), poolSize));
  if (n === 0) return [];
  if (n === poolSize) return Array.from({ length: poolSize }, (_, i) => i);
  if (n > poolSize / 2) {
    const dropped = new Set(sampleIndices(poolSize - n, poolSize, rand));
    const kept: number[] = [];
    for (let i = 0; i < poolSize; i++) if (!dropped.has(i)) kept.push(i);
    return kept;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  while (out.length < n) {
    const i = Math.floor(rand() * poolSize);
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(i);
  }
  return out;
}

/**
 * Split `total` across `count` slots so the first `topCount` take
 * `topSharePct` of it between them, and the rest share what's left with a bit
 * of jitter — each capped at `tailMax`. Returns integer counts.
 *
 * This is what "3 tags account for 40% of links" means mechanically. When the
 * cap makes the remainder unplaceable the slots simply stay under it; nothing
 * is invented to hit the total.
 */
function distribute(
  total: number,
  count: number,
  topCount: number,
  topSharePct: number,
  tailMax: number,
  rand: () => number
): number[] {
  const out = new Array<number>(count).fill(0);
  if (count === 0 || total <= 0) return out;
  const top = Math.min(topCount, count);
  const topTotal = top > 0 ? Math.round((total * topSharePct) / 100) : 0;
  for (let i = 0; i < top; i++) {
    // Spread the top group's share evenly, remainder to the first slots.
    out[i] = Math.floor(topTotal / top) + (i < topTotal % top ? 1 : 0);
  }

  const tailCount = count - top;
  if (tailCount === 0) return out;
  // Whatever the top group didn't take, shared out with jitter so the tail
  // isn't suspiciously uniform.
  const tailBudget = Math.max(0, total - out.reduce((a, b) => a + b, 0));
  let remaining = tailBudget;
  const weights = Array.from({ length: tailCount }, () => 0.2 + rand());
  const weightSum = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < tailCount && remaining > 0; i++) {
    const share = Math.round((tailBudget * weights[i]) / weightSum);
    out[top + i] = Math.min(share, tailMax, remaining);
    remaining -= out[top + i];
  }
  return out;
}

/** bulkPut in chunks so no single IDB transaction gets huge. */
async function chunkedPut<T extends { id: string }>(
  store: string,
  rows: T[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const CHUNK = 5000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bulkPut(store as any, rows.slice(i, i + CHUNK) as any);
    if (rows.length > CHUNK) {
      onProgress?.(
        `Writing ${store}: ${Math.min(i + CHUNK, rows.length).toLocaleString()} / ${rows.length.toLocaleString()}…`
      );
    }
  }
}

const RESOURCE_POOL = [
  ['fzf — fuzzy finder', 'https://github.com/junegunn/fzf'],
  ['ripgrep', 'https://github.com/BurntSushi/ripgrep'],
  ['Superset', 'https://superset.apache.org/demo'],
  ['Basecoat UI', 'https://basecoatui.com/kit'],
  ['OpenGameArt', 'https://opengameart.org/browse'],
  ['Sorting visualizer', 'https://tools.simonwillison.net/sort-demo'],
  ['go-tui', 'https://go-tui.dev/docs'],
  ['Excalidraw', 'https://excalidraw.com/tool'],
  ['LevelUpGo', 'https://levelupgo.dev/lessons'],
  ['Zero sync engine', 'https://zero.rocicorp.dev/docs'],
] as const;

export async function seedDataset(
  options: SeedOptions,
  onProgress?: (msg: string) => void
): Promise<SeedSummary> {
  const o = resolveSeedOptions(options);
  const rand = rng(20260710 + o.linksPerWeek * 1000 + o.weeks);
  const today = currentWeekStart();
  const iso = (day: string, hour: number) =>
    new Date(`${day}T${String(hour % 24).padStart(2, '0')}:00:00`).toISOString();

  // ---- origins: a Zipf-ish pool, so a few domains dominate the way they do
  // in a real library (and the stats page's variability metric has something
  // to measure).
  const origins = Array.from({ length: o.origins }, (_, i) => originName(i));
  const originWeights = origins.map((_, i) => 1 / (i + 1));
  const originTotalWeight = originWeights.reduce((a, b) => a + b, 0);
  const pickOrigin = (): string => {
    let r = rand() * originTotalWeight;
    for (let i = 0; i < origins.length; i++) {
      r -= originWeights[i];
      if (r <= 0) return origins[i];
    }
    return origins[origins.length - 1];
  };

  // ---- tags
  const tags: Tag[] = Array.from({ length: o.tags.count }, (_, i) =>
    withSyncFields({ name: tagName(i), notes_md: '' })
  );
  for (const i of sampleIndices((tags.length * o.tags.describedPct) / 100, tags.length, rand)) {
    tags[i].notes_md = prose(rand, o.tags.descriptionLength, tags[i].name);
  }

  // ---- tag hierarchy: acyclic by construction. A tag may only be nested
  // under an EARLIER tag, so no edge can ever close a loop however many
  // parents it collects — reconcileTagParents never has repair work to do on
  // seeded data, and depth is capped by the level bookkeeping below.
  const tagParents: TagParent[] = [];
  if (o.tags.maxDepth > 1 && tags.length > 1) {
    const level = new Array<number>(tags.length).fill(0);
    const nested = new Set(
      sampleIndices((tags.length * o.tags.nestedPct) / 100, tags.length, rand)
    );
    for (let i = 1; i < tags.length; i++) {
      if (!nested.has(i)) continue;
      const whole = Math.floor(o.tags.parentsPerTag);
      const wanted = whole + (rand() < o.tags.parentsPerTag - whole ? 1 : 0);
      const chosen = new Set<number>();
      for (let attempt = 0; attempt < wanted * 4 && chosen.size < wanted; attempt++) {
        const parent = Math.floor(rand() * i);
        // The parent's own depth plus this edge must stay inside maxDepth.
        if (chosen.has(parent) || level[parent] + 1 > o.tags.maxDepth - 1) continue;
        chosen.add(parent);
        level[i] = Math.max(level[i], level[parent] + 1);
        tagParents.push(
          withSyncFields({ child_id: tags[i].id, parent_id: tags[parent].id })
        );
      }
    }
  }

  // ---- topics
  const topics: Topic[] = Array.from({ length: o.topics.count }, (_, i) => {
    const name = `${TAG_WORDS[i % TAG_WORDS.length]} deep-dive #${i + 1}`;
    return withSyncFields({ name, body_md: '' });
  });
  for (const i of sampleIndices((topics.length * o.topics.describedPct) / 100, topics.length, rand)) {
    topics[i].body_md = prose(rand, o.topics.descriptionLength, topics[i].name);
  }

  // ---- links, week by week (oldest first)
  const links: Link[] = [];
  const weeks: Week[] = [];
  const weekLinks: WeekLink[] = [];
  /** Which week each link was captured in, for the review pass. */
  const weekOfLink: number[] = [];
  /** Links that got a reading entry, and were read — review candidates. */
  const scheduled: boolean[] = [];

  let serial = 0;
  for (let w = o.weeks - 1; w >= 0; w--) {
    const weekStart = weekStartPlus(today, -w);
    const isCurrent = w === 0;
    weeks.push(
      withSyncFields({
        week_start: weekStart,
        closed_at: isCurrent ? null : iso(weekStartPlus(weekStart, 1), 9),
      })
    );
    if (o.weeks > 52 && w % 52 === 0) {
      onProgress?.(`Generating year ${Math.ceil((o.weeks - w) / 52)} / ${Math.ceil(o.weeks / 52)}…`);
    }

    const jitter = Math.round(o.linksPerWeek * 0.15);
    const count = Math.max(1, o.linksPerWeek - jitter + Math.floor(rand() * (2 * jitter + 1)));
    for (let i = 0; i < count; i++) {
      serial++;
      const added = iso(weekStart, 8 + (serial % 12));
      const done = isCurrent ? rand() < 0.3 : rand() < 0.8;
      const doneAt = iso(weekStart, 20);
      links.push(
        withSyncFields({
          url: `https://${pickOrigin()}/nonsense/${serial}`,
          title: `${TITLE_WORDS[serial % TITLE_WORDS.length]} — take ${serial}`,
          title_fetched: true,
          added_at: added,
          read_at: done ? doneAt : null,
          favourite: false,
          is_resource: false,
          slushed_at: null,
          priority: null,
        })
      );
      weekOfLink.push(weeks.length - 1);
      const onList = done || rand() < 0.6;
      scheduled.push(onList);
      if (onList) {
        weekLinks.push(
          withSyncFields({
            week_id: weeks[weeks.length - 1].id,
            link_id: links[links.length - 1].id,
            position: i,
            kind: 'reading' as const,
            done_at: done ? doneAt : null,
            outcome: isCurrent ? null : done ? ('read' as const) : ('rolled' as const),
          })
        );
      }
    }
  }
  const total = links.length;

  // ---- flags, as exact shares of the library
  for (const i of sampleIndices((total * o.favouritePct) / 100, total, rand)) {
    links[i].favourite = true;
  }
  for (const i of sampleIndices((total * o.resourcePct) / 100, total, rand)) {
    links[i].is_resource = true;
  }

  // Slush only makes sense for a link you actually read, and never for a
  // favourite (favouriting clears slushed_at in the app), so the request is
  // capped by how many links qualify.
  const slushCandidates: number[] = [];
  for (let i = 0; i < total; i++) {
    if (links[i].read_at && !links[i].favourite) slushCandidates.push(i);
  }
  const wantSlush = Math.round((total * o.slushPct) / 100);
  const slushed = sampleIndices(wantSlush, slushCandidates.length, rand).map(
    (n) => slushCandidates[n]
  );
  const slushedSet = new Set(slushed);
  for (const i of slushed) links[i].slushed_at = links[i].read_at;
  // A slushed link's week entry closed as 'slushed', not 'read'.
  const indexOfLink = new Map(links.map((l, i) => [l.id, i]));
  for (const entry of weekLinks) {
    if (entry.outcome === 'read' && slushedSet.has(indexOfLink.get(entry.link_id)!)) {
      entry.outcome = 'slushed';
    }
  }

  // ---- tag assignments, distributed across tags
  const linkTags: LinkTag[] = [];
  if (tags.length > 0 && total > 0) {
    const assignments = Math.round(total * o.tags.tagsPerLink);
    const perTag = distribute(
      assignments,
      tags.length,
      o.tags.topCount,
      o.tags.topSharePct,
      Math.max(1, Math.round((total * o.tags.tailMaxSharePct) / 100)),
      rand
    );
    for (let t = 0; t < tags.length; t++) {
      for (const i of sampleIndices(perTag[t], total, rand)) {
        linkTags.push(withSyncFields({ link_id: links[i].id, tag_id: tags[t].id }));
      }
    }
  }

  // ---- topic references, distributed across topics
  const linkTopics: LinkTopic[] = [];
  if (topics.length > 0 && total > 0) {
    const budget = Math.round((total * o.topics.referencesPct) / 100);
    const perTopic = distribute(
      budget,
      topics.length,
      o.topics.topCount,
      o.topics.topSharePct,
      o.topics.maxRefs,
      rand
    );
    for (let t = 0; t < topics.length; t++) {
      const want = Math.min(o.topics.maxRefs, Math.max(o.topics.minRefs, perTopic[t]));
      let refNumber = 0;
      for (const i of sampleIndices(want, total, rand)) {
        refNumber++;
        linkTopics.push(
          withSyncFields({
            link_id: links[i].id,
            topic_id: topics[t].id,
            ref_number: refNumber,
          })
        );
      }
    }
  }

  // ---- prose hanging off links
  const notes: Note[] = [];
  for (const i of sampleIndices((total * o.links.notesPct) / 100, total, rand)) {
    notes.push(withSyncFields({ link_id: links[i].id, body_md: prose(rand, o.links.notesLength) }));
  }
  const excerpts: Excerpt[] = [];
  for (const i of sampleIndices((total * o.links.excerptsPct) / 100, total, rand)) {
    excerpts.push(
      withSyncFields({
        link_id: links[i].id,
        content_md: `> ${prose(rand, o.links.excerptLength)}`,
        position: 0,
      })
    );
  }

  // ---- reviews: a link pulled back into a LATER week, which is what
  // "reviewed at least once" means — the same link appearing in two weeks.
  let reviews = 0;
  if (o.weeks > 1) {
    const candidates: number[] = [];
    for (let i = 0; i < total; i++) {
      if (scheduled[i] && weekOfLink[i] < weeks.length - 1) candidates.push(i);
    }
    for (const n of sampleIndices((total * o.links.reviewedPct) / 100, candidates.length, rand)) {
      const i = candidates[n];
      const from = weekOfLink[i];
      const laterWeek = from + 1 + Math.floor(rand() * (weeks.length - 1 - from));
      const isCurrent = laterWeek === weeks.length - 1;
      const reviewDone = !isCurrent || rand() < 0.5;
      weekLinks.push(
        withSyncFields({
          week_id: weeks[laterWeek].id,
          link_id: links[i].id,
          position: 1000 + reviews,
          kind: 'review' as const,
          done_at: reviewDone ? iso(weeks[laterWeek].week_start, 20) : null,
          outcome: isCurrent ? null : reviewDone ? ('read' as const) : ('rolled' as const),
        })
      );
      reviews++;
    }
  }

  // ---- a handful of standalone resources plus a list grouping them
  const list: ResourceList = withSyncFields({
    name: 'Handy tools',
    description_md: 'Utilities worth keeping around — mostly CLI and web tooling.',
  });
  const listLinks: ResourceListLink[] = [];
  RESOURCE_POOL.forEach(([title, url], i) => {
    const link: Link = withSyncFields({
      url,
      title,
      title_fetched: true,
      added_at: iso(weekStartPlus(today, -(i % Math.min(10, o.weeks))), 12),
      read_at: null,
      favourite: false,
      is_resource: true,
      slushed_at: null,
      priority: null,
    });
    links.push(link);
    if (i < 6) listLinks.push(withSyncFields({ list_id: list.id, link_id: link.id, position: i }));
  });

  await chunkedPut('tags', tags, onProgress);
  await chunkedPut('tag_parents', tagParents, onProgress);
  await chunkedPut('topics', topics, onProgress);
  await chunkedPut('links', links, onProgress);
  await chunkedPut('link_tags', linkTags, onProgress);
  await chunkedPut('link_topics', linkTopics, onProgress);
  await chunkedPut('notes', notes, onProgress);
  await chunkedPut('excerpts', excerpts, onProgress);
  await chunkedPut('weeks', weeks, onProgress);
  await chunkedPut('week_links', weekLinks, onProgress);
  await chunkedPut('resource_lists', [list], onProgress);
  await chunkedPut('resource_list_links', listLinks, onProgress);

  // ---- archival, once everything is stored. Turning it on here also turns it
  // on in settings, so the instance keeps behaving the way the seed described.
  // Left alone entirely when disabled — seeding shouldn't silently flip a
  // preference you set yourself.
  let archived = 0;
  if (o.archive.enabled) {
    onProgress?.('Archiving old slushed links…');
    await saveUserSettings({
      archive_enabled: true,
      archive_after_months: o.archive.afterMonths,
    });
    archived = await archiveNow(o.archive.afterMonths);
  }

  return {
    links: links.length,
    weeks: weeks.length,
    origins: origins.length,
    tags: tags.length,
    tagEdges: tagParents.length,
    tagAssignments: linkTags.length,
    topics: topics.length,
    references: linkTopics.length,
    notes: notes.length,
    excerpts: excerpts.length,
    favourites: links.filter((l) => l.favourite).length,
    resources: links.filter((l) => l.is_resource).length,
    slushed: slushed.length,
    reviews,
    archived,
  };
}
