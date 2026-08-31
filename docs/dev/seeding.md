# Seeding & stress-test datasets

`Settings → Danger zone → Load demo data` generates a synthetic library
([`db/seed.ts`](../../frontend/src/lib/db/seed.ts)). It has two jobs:

1. **Demo** — give a fresh install something to look at, so the app isn't a
   set of empty pages on first run.
2. **Stress test** — build a library with a specific *shape* (hundreds of
   tags, a lopsided tag distribution, a deep nesting DAG, heavy prose, a
   populated archive) so a page can be measured against the thing that will
   actually make it slow.

Two sliders drive the volume; everything else lives behind the **Advanced**
panel and defaults to the friendly demo library, so the simple path is
unchanged.

## Guarantees

These are what make the seeder usable as a measuring instrument rather than a
random-data generator. They are pinned by
[`test/seed.test.ts`](../../frontend/test/seed.test.ts) and
[`tests/sync/seed.spec.ts`](../../frontend/tests/sync/seed.spec.ts).

- **Percentages are exact, not probabilistic.** "12% favourites" samples
  exactly `round(links × 0.12)` distinct links. A control you set is a control
  you can measure — no coin flip per link, no drift at small volumes.
- **Physical limits win, and the summary says so.** Slush needs a link you
  read and never touches a favourite, so a slush request above roughly 75% is
  capped by what is eligible. The returned `SeedSummary` reports what was
  actually written, not what was asked for.
- **Deterministic.** Same options in, same dataset out (seeded mulberry32).
  The seed is derived from the two volume knobs alone (links/week and
  weeks) — no other control re-keys the random stream.
- **Names are unique.** Tag names in particular: duplicates would be folded by
  `reconcileTags` on the first read, silently undoing the count you asked for.
- **The tag graph is acyclic by construction.** A tag is only ever nested
  under an *earlier* tag, so no combination of depth and parent count can
  close a loop — `reconcileTagParents` never has repair work to do on seeded
  data.
- **No duplicate junction pairs**, so `dedupePairs` has nothing to collapse
  either. Seeded data that needed healing would make every subsequent sync
  investigation lie to you.
- **Rows go through the normal stores** with `server_seq: null`, so a seeded
  library pushes and converges exactly like a real one.

Two known gaps: seeded links all carry `priority: null`, so the compound
`priority_added` index is never exercised by seeded data, and no `plans`
rows are generated.

Seeding is additive — it mixes into whatever is already there and mints fresh
ids each run, so repeated runs stack up. Seed onto a fresh install: the fixed
resource-pool URLs in particular are re-inserted verbatim each run (seeding
writes through `bulkPut`, bypassing capture's URL dedupe), so repeated runs
mint duplicate links for the same URLs.

One warning worth heeding: seeding is not sync-aware. The rows land in the
normal stores, so with a server configured the debounced write trigger pushes
the entire dataset ~800 ms after the last chunk lands. Turn sync off (or
point at a throwaway server) before seeding a dataset you don't intend to
keep.

## The controls

| Group | Control | Meaning |
|---|---|---|
| Volume | Usage weight | links per week — the Settings slider runs 5–500 in steps of 5; the API clamps 1–500 |
| | Duration | weeks of history (1–1040, ±15% jitter per week) |
| Origins | Domains to draw from | size of the hostname pool |
| Lifecycle | Favourites / Resources / Slushed | % of generated links |
| | Reviewed at least once | % re-scheduled into a *later* week as `kind: 'review'` |
| | Archive after seeding | turns archival on in settings and runs `archiveNow` |
| Tags | How many tags | count (unique names) |
| | Average tags per link | sets the total assignment budget |
| | Top *n* tags accounting for *x*% | the pinned head of the distribution (n ≤ 5) |
| | Ceiling for every other tag | tail cap, as a % of links |
| | With an about section + length | `notes_md` coverage and size |
| Tag nesting | Nesting depth | 1 = flat; capped at `MAX_TAG_DEPTH` |
| | Nested under a parent | % of tags that get an edge |
| | Average parents per nested tag | above 1 makes it a DAG, not a tree |
| Topics | How many topics | count, or *scale with usage* (the historical rule: 3 per week at a 150-links/week baseline) |
| | Total references | as a % of links |
| | Top *n* topics accounting for *x*% | pinned head of the reference distribution |
| | Fewest / most references per topic | per-topic clamp, applied after the split |
| | With a body document + length | `body_md` coverage and size |
| | Tagged (% of topics) | share of topics carrying at least one `topic_tags` edge |
| | Average tags per tagged topic | edge budget for those topics |
| Notes & excerpts | Links with a note / excerpt + lengths | `notes` and `excerpts` coverage and size |

Prose lengths are expressed the way you'd say them out loud — "at least one
sentence, at most twelve paragraphs" — with a paragraph counted as five
sentences.

## Shape notes

**Origins are Zipf-weighted.** Link *n* in the pool gets weight `1/(n+1)`, so
the first few domains dominate the way they do in a real library. This is what
gives the stats page's **variability** metric something to measure; a uniform
pool would score ~100% and tell you nothing.

**The top-*n* split is even.** "3 tags accounting for 40%" gives each of the
three a third of that 40%; the remaining tags share what's left with jitter,
each capped by the tail ceiling. When the cap makes the remainder unplaceable,
slots simply stay under it — nothing is invented to hit the total.

**Topic reference clamping happens last.** `minRefs`/`maxRefs` are applied
after the distribution split, so with many topics and a low reference budget
`minRefs` can push the total above the requested percentage. That is
deliberate: a topic with zero references is not a useful test fixture.

**Topic tags are exact on the share, best-effort on the average.**
`taggedPct` picks exactly that share of topics; the budget
(`tagged x tagsPerTopic`) is then spread as evenly as the remainder allows and
clamped per topic to **at least one** (a tagged topic with no tag would make
the share a lie) and **at most the number of tags that exist** (you cannot
carry more distinct tags than there are). Either clamp shows up in
`SeedSummary.topicTags`, which reports what was really written. The tags on
one topic are always distinct, so seeded data satisfies the `topic_tags-pair`
invariant with nothing left for `dedupeTopicTags` to heal.

**One fixed resource list.** Every run seeds the same "Handy tools" list from
a fixed ten-URL pool (`RESOURCE_POOL`), adding the first six as members. It
answers to no control and is not reported in the `SeedSummary` — it exists so
the resource-list pages have something to show.

## Archival and the local-only cold store

Turning on the archive control writes `archive_enabled` and
`archive_after_months` into `user_settings` and then runs `archiveNow` once
the data is stored. It is left completely alone when disabled — seeding should
not silently flip a preference you set yourself.

Note the consequence, which is the app's normal archival behaviour rather than
anything the seeder invents: archiving **hard-deletes** from `links` into the
local-only `archived_links` store, and push only scans the synced stores. A
link archived before it was ever pushed therefore stays on that device until
`resetLocalSyncState` moves it back. Related rows (`week_links`, `notes`,
joins) also stay in place pointing at the cold copy, so the harness's
referential-integrity invariant fires by design on a device with archived
links — `seed.spec.ts` asserts every dangling reference is explained by an
archived id rather than demanding none exist.
