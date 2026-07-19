/**
 * Demo data seeding, parameterized by usage weight and duration (#17 + the
 * sliders): `linksPerWeek` up to 200 and `weeks` up to 520 (10 years).
 * Notes, topics, favourites, and resources scale with usage. Content is
 * nonsense — the point is realistic *volume* and lifecycle shape, so you
 * can feel what multi-year usage does to the app. Deterministic (seeded
 * PRNG); everything goes through the normal stores and syncs like real
 * data, and repeated runs add duplicates (new ids each run).
 */
import { bulkPut, withSyncFields } from './repo';
import { weekStartPlus, currentWeekStart } from '../services/weeks';
import type {
  Excerpt,
  Link,
  LinkTag,
  LinkTopic,
  Note,
  ResourceList,
  ResourceListLink,
  Tag,
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

const THEMES = [
  {
    tag: 'databases',
    titles: ['B-Trees explained', 'WAL deep dive', 'Postgres locks', 'SQLite internals', 'Query planning', 'MVCC in practice'],
    hosts: ['sqlite.org', 'planetscale.com', 'brooker.co.za', 'muratbuffalo.blogspot.com'],
  },
  {
    tag: 'go',
    titles: ['Go error handling', 'Goroutine patterns', 'pprof profiling', 'Generics in Go', 'Go runtime scheduler', 'Table-driven tests'],
    hosts: ['go.dev', 'threedots.tech', 'lesiw.dev', 'titpetric.com'],
  },
  {
    tag: 'webdev',
    titles: ['HTMX vs SPA', 'CSS container queries', 'Astro islands', 'Service worker caching', 'View transitions', 'Local-first sync'],
    hosts: ['astro.build', 'developer.mozilla.org', 'kieranwood.ca', 'joshwcomeau.com'],
  },
  {
    tag: 'ai',
    titles: ['Attention explained', 'RAG pipelines', 'Tokenizers by hand', 'Eval harnesses', 'Quantization tricks', 'Agents in production'],
    hosts: ['arxiv.org', 'huggingface.co', 'simonwillison.net', 'byhand.ai'],
  },
  {
    tag: 'hardware',
    titles: ['PCB fabrication', 'Wi-Fi 7 explained', 'DRAM price fixing', 'Keyboard firmware', 'SSD internals', 'RISC-V boards'],
    hosts: ['youtube.com', 'hackaday.com', 'anandtech.com', 'ieee.org'],
  },
];

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

const PARA =
  'Notes accumulated over several reads. The interesting failure modes cluster around the edges: retries, partial writes, and clocks. See the referenced links for worked examples.\n\n';

export interface SeedOptions {
  /** Capture rate; the demo default is 20, the scaling.md ceiling is 200. */
  linksPerWeek: number;
  /** How far back to generate; 52 per year, up to 520. */
  weeks: number;
}

export interface SeedSummary {
  links: number;
  weeks: number;
  tags: number;
  topics: number;
  notes: number;
  favourites: number;
  resources: number;
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

export async function seedDataset(
  options: SeedOptions,
  onProgress?: (msg: string) => void
): Promise<SeedSummary> {
  const linksPerWeek = Math.max(1, Math.min(200, Math.round(options.linksPerWeek)));
  const WEEKS = Math.max(1, Math.min(520, Math.round(options.weeks)));
  const rand = rng(20260710 + linksPerWeek * 1000 + WEEKS);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const chance = (p: number) => rand() < p;

  const today = currentWeekStart();
  const iso = (day: string, hour: number) =>
    new Date(`${day}T${String(hour % 24).padStart(2, '0')}:00:00`).toISOString();

  // Rates observed at ~150 links/week (the user's real usage), scaled.
  const usage = linksPerWeek / 150;
  const notesPerWeekCap = Math.max(1, Math.round(10 * usage));
  const topicsTotal = Math.max(1, Math.round(3 * usage * WEEKS));

  const tags: Tag[] = THEMES.map((t) => withSyncFields({ name: t.tag, notes_md: '' }));

  const topics: Topic[] = [];
  for (let i = 0; i < topicsTotal; i++) {
    const theme = pick(THEMES);
    topics.push(
      withSyncFields({
        name: `${theme.tag} deep-dive #${i + 1}`,
        body_md: `# ${theme.tag} deep-dive #${i + 1}\n\n${PARA.repeat(2 + Math.floor(rand() * 6))}`,
      })
    );
  }

  const links: Link[] = [];
  const linkTags: LinkTag[] = [];
  const linkTopics: LinkTopic[] = [];
  /** Next footnote number per topic, so seeded references number 1..n. */
  const refCounters = new Map<string, number>();
  const notes: Note[] = [];
  const excerpts: Excerpt[] = [];
  const weeks: Week[] = [];
  const weekLinks: WeekLink[] = [];

  let serial = 0;
  for (let w = WEEKS - 1; w >= 0; w--) {
    const weekStart = weekStartPlus(today, -w);
    const isCurrent = w === 0;
    const week: Week = withSyncFields({
      week_start: weekStart,
      closed_at: isCurrent ? null : iso(weekStartPlus(weekStart, 1), 9),
    });
    weeks.push(week);
    if (WEEKS > 52 && w % 52 === 0) {
      onProgress?.(`Generating year ${Math.ceil((WEEKS - w) / 52)} / ${Math.ceil(WEEKS / 52)}…`);
    }

    const jitter = Math.round(linksPerWeek * 0.15);
    const count = Math.max(1, linksPerWeek - jitter + Math.floor(rand() * (2 * jitter + 1)));
    let notesThisWeek = 0;
    for (let i = 0; i < count; i++) {
      serial++;
      const theme = pick(THEMES);
      const added = iso(weekStartPlus(weekStart, 0), 8 + (serial % 12));
      const favourite = chance(0.02);
      const isResource = chance(0.03);
      const inTopic = chance(0.02);
      const done = isCurrent ? chance(0.3) : chance(0.8);
      const slushed = done && !favourite && !inTopic;
      const doneAt = iso(weekStartPlus(weekStart, 0), 20);

      const link: Link = withSyncFields({
        url: `https://${pick(theme.hosts)}/nonsense/${theme.tag}/${serial}`,
        title: `${pick(theme.titles)} — take ${serial}`,
        title_fetched: true,
        added_at: added,
        read_at: done ? doneAt : null,
        favourite,
        is_resource: isResource,
        slushed_at: slushed ? doneAt : null,
        priority: null,
      });
      links.push(link);

      if (chance(0.8)) {
        linkTags.push(withSyncFields({ link_id: link.id, tag_id: tags[THEMES.indexOf(theme)].id }));
      }
      if (inTopic) {
        const topicId = topics[Math.floor(rand() * topics.length)].id;
        const ref_number = (refCounters.get(topicId) ?? 0) + 1;
        refCounters.set(topicId, ref_number);
        linkTopics.push(withSyncFields({ link_id: link.id, topic_id: topicId, ref_number }));
      }
      if (done && notesThisWeek < notesPerWeekCap && chance(0.08)) {
        notesThisWeek++;
        notes.push(
          withSyncFields({ link_id: link.id, body_md: PARA.repeat(1 + Math.floor(rand() * 2)) })
        );
        if (chance(0.4)) {
          excerpts.push(
            withSyncFields({ link_id: link.id, content_md: `"Quote ${serial} worth keeping."`, position: 0 })
          );
        }
      }
      if (chance(0.6) || done) {
        weekLinks.push(
          withSyncFields({
            week_id: week.id,
            link_id: link.id,
            position: i,
            kind: 'reading' as const,
            done_at: done ? doneAt : null,
            outcome: isCurrent ? null : done ? (slushed ? ('slushed' as const) : ('read' as const)) : ('rolled' as const),
          })
        );
      }
    }
  }

  // A handful of standalone resources plus a list grouping them.
  const list: ResourceList = withSyncFields({
    name: 'Handy tools',
    description_md: 'Utilities worth keeping around — mostly CLI and web tooling.',
  });
  const listLinks: ResourceListLink[] = [];
  const resourceLinks: Link[] = RESOURCE_POOL.map(([title, url], i) => {
    const link: Link = withSyncFields({
      url,
      title,
      title_fetched: true,
      added_at: iso(weekStartPlus(today, -(i % Math.min(10, WEEKS))), 12),
      read_at: null,
      favourite: false,
      is_resource: true,
      slushed_at: null,
      priority: null,
    });
    if (i < 6) {
      listLinks.push(withSyncFields({ list_id: list.id, link_id: link.id, position: i }));
    }
    return link;
  });
  links.push(...resourceLinks);

  await chunkedPut('tags', tags, onProgress);
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

  return {
    links: links.length,
    weeks: weeks.length,
    tags: tags.length,
    topics: topics.length,
    notes: notes.length,
    favourites: links.filter((l) => l.favourite).length,
    resources: links.filter((l) => l.is_resource).length,
  };
}
