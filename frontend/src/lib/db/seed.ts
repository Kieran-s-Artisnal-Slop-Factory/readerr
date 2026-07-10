/**
 * Demo data seeding (#17): ~3 months of realistic usage — 13 weeks
 * averaging 20 links each, tags, 3 topic documents, favourites, resources,
 * a resource list, notes and excerpts, and closed weeks with lifecycle
 * outcomes. Deterministic (seeded PRNG) so repeated runs look the same;
 * everything goes through the normal stores and syncs like real data.
 */
import { bulkPut, withSyncFields } from './repo';
import { weekStartOf, weekStartPlus, currentWeekStart } from '../services/weeks';
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

export interface SeedSummary {
  links: number;
  weeks: number;
  tags: number;
  topics: number;
  favourites: number;
  resources: number;
}

export async function seedDemoData(): Promise<SeedSummary> {
  const rand = rng(20260710);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
  const chance = (p: number) => rand() < p;

  const today = currentWeekStart();
  const iso = (day: string, hour: number) =>
    new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString();

  const tags: Tag[] = THEMES.map((t) => withSyncFields({ name: t.tag, notes_md: '' }));

  const topics: Topic[] = [
    { name: 'Database internals', body_md: '# Database internals\n\nHow storage engines actually work: B-trees vs LSM, WAL, and the read/write paths.\n' },
    { name: 'Go patterns', body_md: '# Go patterns\n\nIdioms worth keeping: functional options, table tests, and error wrapping.\n' },
    { name: 'Local-first apps', body_md: '# Local-first apps\n\nIndexedDB as the source of truth, sync as an add-on. Notes on CRDTs vs LWW.\n' },
  ].map((t) => withSyncFields(t));
  const topicByTag: Record<string, Topic | undefined> = {
    databases: topics[0],
    go: topics[1],
    webdev: topics[2],
  };

  const links: Link[] = [];
  const linkTags: LinkTag[] = [];
  const linkTopics: LinkTopic[] = [];
  const notes: Note[] = [];
  const excerpts: Excerpt[] = [];
  const weeks: Week[] = [];
  const weekLinks: WeekLink[] = [];

  let serial = 0;
  for (let w = 12; w >= 0; w--) {
    const weekStart = weekStartPlus(today, -w);
    const isCurrent = weekStart === today;
    const week: Week = withSyncFields({
      week_start: weekStart,
      closed_at: isCurrent ? null : iso(weekStartPlus(weekStart, 1), 9),
    });
    weeks.push(week);

    const count = 17 + Math.floor(rand() * 7); // ~20/week
    for (let i = 0; i < count; i++) {
      serial++;
      const theme = pick(THEMES);
      const day = weekStartOf(new Date(`${weekStart}T00:00:00`));
      const addedDay = weekStartPlus(day, 0); // Monday; spread below
      const d = new Date(`${addedDay}T00:00:00`);
      d.setDate(d.getDate() + Math.floor(rand() * 7));
      const added = new Date(d);
      added.setHours(8 + Math.floor(rand() * 12));

      const host = pick(theme.hosts);
      const title = `${pick(theme.titles)} (${serial})`;
      const url = `https://${host}/demo/${theme.tag}-${serial}`;
      const favourite = chance(0.03);
      const isResource = chance(0.04);
      const inTopic = !!topicByTag[theme.tag] && chance(0.18);

      // Lifecycle: closed weeks resolved ~70% of their entries.
      const done = isCurrent ? chance(0.3) : chance(0.7);
      const slushed = done && !favourite && !inTopic;
      const doneAt = iso(weekStartPlus(weekStart, 0), 20);

      const link: Link = withSyncFields({
        url,
        title,
        title_fetched: true,
        added_at: added.toISOString(),
        read_at: done ? doneAt : null,
        favourite,
        is_resource: isResource,
        slushed_at: slushed ? doneAt : null,
      });
      links.push(link);

      if (chance(0.75)) {
        linkTags.push(withSyncFields({ link_id: link.id, tag_id: tags.find((t) => t.name === theme.tag)!.id }));
      }
      if (inTopic) {
        linkTopics.push(withSyncFields({ link_id: link.id, topic_id: topicByTag[theme.tag]!.id }));
      }
      if (done && chance(0.2)) {
        notes.push(withSyncFields({ link_id: link.id, body_md: `Takeaways from *${title}*: worth revisiting when it comes up again.` }));
      }
      if (done && chance(0.1)) {
        excerpts.push(withSyncFields({ link_id: link.id, content_md: `"The interesting part of ${theme.tag} is never the happy path."`, position: 0 }));
      }

      // Roughly half of each week's captures were scheduled into the week.
      if (chance(0.5) || done) {
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
      added_at: iso(weekStartPlus(today, -(i % 10)), 12),
      read_at: null,
      favourite: false,
      is_resource: true,
      slushed_at: null,
    });
    if (i < 6) {
      listLinks.push(withSyncFields({ list_id: list.id, link_id: link.id, position: i }));
    }
    return link;
  });
  links.push(...resourceLinks);

  await bulkPut('tags', tags);
  await bulkPut('topics', topics);
  await bulkPut('links', links);
  await bulkPut('link_tags', linkTags);
  await bulkPut('link_topics', linkTopics);
  await bulkPut('notes', notes);
  await bulkPut('excerpts', excerpts);
  await bulkPut('weeks', weeks);
  await bulkPut('week_links', weekLinks);
  await bulkPut('resource_lists', [list]);
  await bulkPut('resource_list_links', listLinks);

  return {
    links: links.length,
    weeks: weeks.length,
    tags: tags.length,
    topics: topics.length,
    favourites: links.filter((l) => l.favourite).length,
    resources: links.filter((l) => l.is_resource).length,
  };
}
