<script lang="ts">
  /**
   * Upcoming weeks: a calendar-like strip of the coming weeks showing what's
   * planned for each (the plan note, or its focus tags), and a detail panel
   * for the focused week — its plan and the links already scheduled into it.
   * Prev/Next scroll the focus through the weeks.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import LinkList from '../LinkList.svelte';
  import PlanEditor from '../PlanEditor.svelte';
  import { all, get, put, withSyncFields } from '../../lib/db/repo';
  import { tagsForLinks } from '../../lib/services/links';
  import {
    deletePlan,
    effectiveTriage,
    focusIdsOf,
    governingPlan,
    savePlan,
    weekPlan,
    type EffectiveTriage,
    type PlanFields,
  } from '../../lib/services/plans';
  import {
    currentWeekStart,
    findWeek,
    formatWeekRange,
    weekEntries,
    weekStartPlus,
    type WeekEntry,
  } from '../../lib/services/weeks';
  import type { Link, Plan, Tag } from '../../lib/db/types';

  const WEEKS_SHOWN = 8;

  interface WeekCard {
    weekStart: string;
    note: string;
    focusTagNames: string[];
    quota: number | null;
    scheduledCount: number;
  }

  let loading = $state(true);
  let stripStart = $state(currentWeekStart()); // first week in the visible strip
  let focusWeek = $state(currentWeekStart());
  let cards = $state<WeekCard[]>([]);

  // Focused-week detail
  let focusTriage = $state<EffectiveTriage | null>(null);
  let focusNote = $state('');
  let focusFocusTags = $state<string[]>([]);
  let entries = $state<WeekEntry[]>([]);
  let tagsByLink = $state<Map<string, Tag[]>>(new Map());

  // Editing the focused week's plan. The panel is week-granular, so it always
  // edits the WEEKLY plan for that week — never the monthly plan that may be
  // governing it, which would silently retune every other week in the month.
  // With no weekly plan yet, the form is seeded from the values currently in
  // effect and saving creates an override for this week alone.
  let allTags = $state<Tag[]>([]);
  let ownPlan = $state<Plan | null>(null);
  let editing = $state(false);
  let saving = $state(false);

  const stripWeeks = $derived(
    Array.from({ length: WEEKS_SHOWN }, (_, i) => weekStartPlus(stripStart, i))
  );

  function fmt(weekStart: string): string {
    return new Date(`${weekStart}T00:00:00`).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  }

  async function tagNames(ids: string[]): Promise<string[]> {
    const names: string[] = [];
    for (const id of ids) {
      const tag = await get<Tag>('tags', id);
      if (tag) names.push(tag.name);
    }
    return names;
  }

  async function buildCards() {
    const out: WeekCard[] = [];
    for (const weekStart of stripWeeks) {
      const plan = await governingPlan(weekStart);
      const triage = await effectiveTriage(weekStart);
      const week = await findWeek(weekStart);
      const scheduledCount = week ? (await weekEntries(week.id)).length : 0;
      out.push({
        weekStart,
        note: plan?.note ?? '',
        focusTagNames: await tagNames(triage.focusTagIds),
        quota: triage.quota,
        scheduledCount,
      });
    }
    cards = out;
  }

  async function loadFocus() {
    focusTriage = await effectiveTriage(focusWeek);
    const plan = await governingPlan(focusWeek);
    focusNote = plan?.note ?? '';
    focusFocusTags = await tagNames(focusTriage.focusTagIds);
    ownPlan = await weekPlan(focusWeek);
    const week = await findWeek(focusWeek);
    const rows = week ? await weekEntries(week.id) : [];
    entries = rows;
    tagsByLink = await tagsForLinks(rows.map((e) => e.link));
  }

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    allTags = [...allTags, tag].sort((a, b) => a.name.localeCompare(b.name));
    return tag.id;
  }

  async function saveWeekPlan(fields: PlanFields) {
    saving = true;
    try {
      await savePlan('week', focusWeek, fields);
      editing = false;
      await Promise.all([loadFocus(), buildCards()]);
    } finally {
      saving = false;
    }
  }

  async function clearWeekPlan() {
    if (!ownPlan) return;
    if (!confirm(`Remove this week's plan? It will fall back to the monthly plan or your defaults.`)) {
      return;
    }
    await deletePlan(ownPlan.id);
    editing = false;
    await Promise.all([loadFocus(), buildCards()]);
  }

  onMount(async () => {
    focusWeek = weekStartPlus(currentWeekStart(), 1); // default to next week
    allTags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    await Promise.all([buildCards(), loadFocus()]);
    loading = false;
  });

  async function selectWeek(weekStart: string) {
    focusWeek = weekStart;
    editing = false; // a different week means a different plan
    await loadFocus();
  }

  async function shiftFocus(dir: -1 | 1) {
    focusWeek = weekStartPlus(focusWeek, dir);
    editing = false; // a different week means a different plan
    // Keep the focused week inside the visible strip.
    if (focusWeek < stripStart) {
      stripStart = focusWeek;
      await buildCards();
    } else if (focusWeek > weekStartPlus(stripStart, WEEKS_SHOWN - 1)) {
      stripStart = weekStartPlus(focusWeek, -(WEEKS_SHOWN - 1));
      await buildCards();
    }
    await loadFocus();
  }

  async function shiftStrip(dir: -1 | 1) {
    stripStart = weekStartPlus(stripStart, dir * WEEKS_SHOWN);
    await buildCards();
  }

  function onRowChange(updated: Link) {
    entries = entries.map((e) => (e.link.id === updated.id ? { ...e, link: updated } : e));
  }

  const isThisOrLater = (ws: string) => ws >= currentWeekStart();
</script>

{#if loading}
  <p class="empty">Loading…</p>
{:else}
  <div class="stack">
    <Card title="Planned weeks">
      <div class="cal-head">
        <button class="btn" onclick={() => shiftStrip(-1)}>← Earlier</button>
        <span class="muted">Weeks of {fmt(stripStart)} – {fmt(weekStartPlus(stripStart, WEEKS_SHOWN - 1))}</span>
        <button class="btn" onclick={() => shiftStrip(1)}>Later →</button>
      </div>
      <div class="calendar">
        {#each cards as card (card.weekStart)}
          <button
            type="button"
            class="cal-cell"
            class:focused={card.weekStart === focusWeek}
            class:current={card.weekStart === currentWeekStart()}
            onclick={() => selectWeek(card.weekStart)}
          >
            <span class="cal-date">
              {card.weekStart === currentWeekStart() ? 'This week' : fmt(card.weekStart)}
            </span>
            {#if card.note}
              <span class="cal-note">{card.note}</span>
            {:else if card.focusTagNames.length > 0}
              <span class="cal-tags">
                {#each card.focusTagNames as name (name)}
                  <span class="cal-tag">{name}</span>
                {/each}
              </span>
            {:else}
              <span class="cal-empty">—</span>
            {/if}
            <span class="cal-meta">
              {card.scheduledCount} scheduled{#if card.quota != null} · quota {card.quota}{/if}
            </span>
          </button>
        {/each}
      </div>
    </Card>

    <Card
      title={`${focusWeek === currentWeekStart() ? 'This week' : `Week of ${formatWeekRange(focusWeek)}`}${isThisOrLater(focusWeek) ? '' : ' (past)'}`}
    >
      <div class="focus-nav">
        <button class="btn" onclick={() => shiftFocus(-1)}>← Previous</button>
        <span class="focus-summary">
          {#if focusFocusTags.length > 0}
            Focus: {focusFocusTags.join(' + ')}
          {:else}
            No focus tags
          {/if}
          {#if focusTriage?.quota != null} · quota {focusTriage.quota}{/if}
        </span>
        <button class="btn" onclick={() => shiftFocus(1)}>Next →</button>
      </div>
      {#if focusNote}
        <p class="focus-note">{focusNote}</p>
      {/if}

      <div class="plan-bar">
        <span class="muted plan-origin">
          {#if ownPlan}
            This week has its own plan.
          {:else if focusTriage && (focusTriage.quotaSource === 'month' || focusTriage.focusSource === 'month')}
            Following the monthly plan — saving here overrides this week only.
          {:else}
            Following your defaults — saving here overrides this week only.
          {/if}
        </span>
        <div class="plan-actions">
          {#if ownPlan}
            <button class="btn btn-danger" onclick={clearWeekPlan}>Clear week plan</button>
          {/if}
          <button class="btn" aria-expanded={editing} onclick={() => (editing = !editing)}>
            {editing ? 'Close' : ownPlan ? 'Edit plan' : 'Plan this week'}
          </button>
        </div>
      </div>
      {#if editing}
        <!-- keyed on the week so switching weeks re-seeds the draft -->
        {#key focusWeek}
          <div class="plan-edit">
            <PlanEditor
              tags={allTags}
              initial={{
                articles_per_week: ownPlan
                  ? (ownPlan.articles_per_week ?? null)
                  : (focusTriage?.quota ?? null),
                focus_tag_ids: ownPlan ? focusIdsOf(ownPlan) : (focusTriage?.focusTagIds ?? []),
                note: ownPlan?.note ?? '',
              }}
              saveLabel={ownPlan ? 'Save changes' : 'Create week plan'}
              ariaLabel="Week plan"
              busy={saving}
              onSave={(fields) => saveWeekPlan(fields)}
              onCancel={() => (editing = false)}
              onCreateTag={createTag}
            />
          </div>
        {/key}
      {/if}

      <h3 class="section-h">Scheduled reading ({entries.length})</h3>
      <LinkList
        links={entries.map((e) => e.link)}
        {tagsByLink}
        onChange={onRowChange}
        empty="Nothing scheduled for this week yet — pick links into it from the backlog or the Reading List."
      />
    </Card>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-5) 0;
  }

  .cal-head,
  .focus-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .calendar {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: var(--space-2);
  }

  .cal-cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    background: var(--surface-color);
    color: var(--text-color);
    cursor: pointer;
    min-height: 5rem;
  }

  .cal-cell:hover {
    border-color: var(--color-primary);
  }

  .cal-cell.focused {
    border-color: var(--color-primary);
    background: var(--color-primary-soft);
  }

  .cal-cell.current .cal-date {
    color: var(--color-primary-strong);
  }

  .cal-date {
    font-weight: 700;
    font-size: var(--font-size-sm);
  }

  .cal-note {
    font-size: var(--font-size-sm);
    color: var(--text-color);
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .cal-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .cal-tag {
    font-size: var(--font-size-sm);
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
  }

  .cal-empty {
    color: var(--text-muted-color);
  }

  .cal-meta {
    margin-top: auto;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .focus-summary {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .focus-note {
    background: var(--surface-raised-color);
    border: 1px solid var(--border-color);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin: 0 0 var(--space-3);
    white-space: pre-wrap;
  }

  .plan-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    flex-wrap: wrap;
    padding-top: var(--space-3);
    border-top: 1px solid var(--border-color);
    margin-top: var(--space-3);
  }

  .plan-origin {
    font-size: var(--font-size-sm);
    min-width: 0;
  }

  .plan-actions {
    display: flex;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .plan-edit {
    padding: var(--space-3) 0;
  }

  .section-h {
    margin: 0 0 var(--space-2);
    font-size: var(--font-size-base);
  }
</style>
