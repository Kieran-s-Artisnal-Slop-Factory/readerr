# Sync test matrix

Every piece of app state, verified across devices against a real backend.

**Method:** Device A creates/edits the item and syncs (push). Device B is a
fresh install that pulls, then we assert the item arrived intact.
Bidirectional items are edited/deleted on B, synced, and re-checked on a
fresh pull. Driven by a two-device harness (clear local + `/sync/reset` the
Go backend between rounds; cursors reset per device).

**Result: all checks pass.** One bug found — duplicate `user_settings`
rows: every device's onboarding minted a fresh-UUID settings row, so two
devices held two non-merging rows and the app read a nondeterministic
`all('user_settings')[0]` (one device's prefs shadowing the other's, while
links/notes/etc. synced fine). Fixed by making the settings row a singleton
at a fixed id + a reconcile-on-read that heals existing duplicates.

Legend: ✅ verified · ⬜ pending

## Stores — create & pull (A → B)

- ✅ `user_settings` — **singleton, exactly one row on B (rawSettings: 1)**
  - ✅ name / articles_per_week / focus_tag_ids (array)
  - ✅ strip_query_params (enum) / strip_whitelist (array)
  - ✅ auto_title (bool) / default_week (enum) / default_week_offset
  - ✅ archive_enabled (bool) / archive_after_months / capture_tag_sort (enum)
  - ✅ onboarding_completed_at
- ✅ `plans` (period enum, starts_on, articles_per_week, focus_tag_ids array, note)
- ✅ `links` (url, title, title_fetched bool, added_at, read_at nullable, favourite/is_resource bools, slushed_at, priority nullable)
- ✅ `tags` (name, notes_md markdown)
- ✅ `link_tags` (link_id, tag_id join)
- ✅ `topics` (name, body_md markdown)
- ✅ `link_topics` (link_id, topic_id join)
- ✅ `notes` (link_id, body_md markdown)
- ✅ `excerpts` (link_id, content_md, position)
- ✅ `resource_lists` (name, description_md)
- ✅ `resource_list_links` (list_id, link_id, position)
- ✅ `weeks` (week_start, closed_at nullable)
- ✅ `week_links` (week_id, link_id, position, kind enum, done_at nullable, outcome nullable)

## Field-type fidelity (wire ↔ storage)

- ✅ JSON arrays round-trip (focus_tag_ids, strip_whitelist)
- ✅ Booleans round-trip (auto_title, archive_enabled, favourite, is_resource, title_fetched)
- ✅ Enums round-trip (strip_query_params 'all', default_week 'current', capture_tag_sort 'alpha', plan.period 'week', week_link.kind 'reading')
- ✅ Nullable fields round-trip (read_at, priority, closed_at, done_at, outcome)
- ✅ Markdown prose round-trips (tags.notes_md, topics.body_md, notes.body_md, excerpts.content_md)

## Operations (edit / delete / bidirectional)

- ✅ Edit settings on B (name, quota) → propagates to a fresh pull
- ✅ Edit a link on B (read_at, favourite, priority) → propagates
- ✅ Soft-delete on B (tombstone an excerpt) → gone on fresh pull, tombstone present
- ✅ Last-write-wins: older local (updated_at 2000) overwritten by newer server on pull; not pushed
- ✅ Re-sync is idempotent (immediate second syncNow → 0 pushed, 0 pulled)
- ✅ Restore path (connect to existing server) creates no local settings — adopts the server's (pushed 0)
- ✅ Reconcile heals a pre-broken 2-row install to 1 (keeps completed-onboarding row, idempotent)
