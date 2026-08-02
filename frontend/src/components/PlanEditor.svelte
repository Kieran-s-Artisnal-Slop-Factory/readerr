<script module lang="ts">
  // Per-instance id seed. The Automation page shows this editor alongside its
  // own "new plan" form, so fixed ids would collide and every label would be
  // ambiguous — for assistive tech as much as for tests.
  let instances = 0;
</script>

<script lang="ts">
  /**
   * The editing form for one scheduled plan's fields, shared by the Automation
   * page (editing a row in the scheduled list) and the Upcoming Weeks page
   * (editing the plan for the focused week) so both behave identically.
   *
   * It owns only its draft state: `onSave` receives the parsed values and the
   * caller decides what that means (create, update, or move). `showPeriod`
   * exposes the period/date controls — the Upcoming page hides them because the
   * week being edited is fixed by the calendar selection.
   */
  import ChipSelect from './ChipSelect.svelte';
  import { periodStart, type PlanFields } from '../lib/services/plans';
  import type { PlanPeriod, Tag } from '../lib/db/types';

  let {
    tags,
    initial,
    initialPeriod = 'week',
    initialDate = '',
    showPeriod = false,
    saveLabel = 'Save',
    ariaLabel = 'Plan',
    busy = false,
    onSave,
    onCancel,
    onCreateTag,
  }: {
    tags: Tag[];
    initial: PlanFields;
    /** Only meaningful with showPeriod. */
    initialPeriod?: PlanPeriod;
    initialDate?: string;
    /** Show the period/date controls (the Automation page can move a plan). */
    showPeriod?: boolean;
    saveLabel?: string;
    /** Names the form, so co-existing plan forms are distinguishable. */
    ariaLabel?: string;
    busy?: boolean;
    onSave: (draft: PlanFields, period: PlanPeriod, date: string) => void | Promise<void>;
    onCancel?: () => void;
    onCreateTag: (name: string) => Promise<string>;
  } = $props();

  // Seeded once from `initial`: this is a draft, so later prop churn (a
  // background refresh) must not yank half-typed values out from under the user.
  let quota = $state(initial.articles_per_week != null ? String(initial.articles_per_week) : '');
  let focusIds = $state([...initial.focus_tag_ids]);
  let note = $state(initial.note);
  let period = $state<PlanPeriod>(initialPeriod);
  let date = $state(initialDate);

  const uid = `pe${++instances}`;

  const startsOn = $derived(showPeriod && date ? periodStart(period, date) : '');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || (showPeriod && !date)) return;
    const n = parseInt(quota, 10);
    void onSave(
      {
        articles_per_week: Number.isFinite(n) && n > 0 ? n : null,
        focus_tag_ids: focusIds,
        note: note.trim(),
      },
      period,
      date
    );
  }
</script>

<form class="plan-editor" aria-label={ariaLabel} onsubmit={submit}>
  {#if showPeriod}
    <div class="row2">
      <div>
        <label for="{uid}-period">Period</label>
        <select id="{uid}-period" bind:value={period}>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </div>
      <div>
        <label for="{uid}-date">
          {period === 'week' ? 'Any day in that week' : 'Any day in that month'}
        </label>
        <input id="{uid}-date" type="date" bind:value={date} min="2020-01-01" />
      </div>
    </div>
  {/if}
  <div>
    <label for="{uid}-quota">Articles per week (blank = inherit)</label>
    <input id="{uid}-quota" type="number" min="1" bind:value={quota} placeholder="inherit" />
  </div>
  <div>
    <span class="field-label">Focus tags (none selected = inherit)</span>
    <ChipSelect
      items={tags}
      bind:selected={focusIds}
      createPlaceholder="New tag…"
      onCreate={onCreateTag}
    />
  </div>
  <div>
    <label for="{uid}-note">Note (optional)</label>
    <input id="{uid}-note" type="text" bind:value={note} placeholder="e.g. compilers deep-dive" />
  </div>
  <div class="form-foot">
    {#if startsOn}
      <span class="muted">Will apply from {startsOn}</span>
    {/if}
    {#if onCancel}
      <button type="button" class="btn" onclick={onCancel} disabled={busy}>Cancel</button>
    {/if}
    <button type="submit" class="btn btn-primary" disabled={busy || (showPeriod && !date)}>
      {busy ? 'Saving…' : saveLabel}
    </button>
  </div>
</form>

<style>
  .plan-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .field-label {
    display: block;
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
    font-weight: 600;
    margin-bottom: var(--space-2);
  }

  .form-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  @media (max-width: 30rem) {
    .row2 {
      grid-template-columns: 1fr;
    }
  }
</style>
