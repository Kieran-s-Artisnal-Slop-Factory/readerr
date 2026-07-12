<script lang="ts">
  /**
   * Plan: the triage defaults (moved here from Settings) plus scheduled
   * weekly/monthly plans that override them when their period arrives.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import ChipSelect from '../ChipSelect.svelte';
  import { all, put, withSyncFields } from '../../lib/db/repo';
  import { getUserSettings, saveUserSettings } from '../../lib/services/settings';
  import { deletePlan, focusIdsOf, listPlans, periodEnd, periodStart, savePlan } from '../../lib/services/plans';
  import { currentWeekStart } from '../../lib/services/weeks';
  import type { Plan, PlanPeriod, Tag } from '../../lib/db/types';

  let loading = $state(true);
  let message = $state('');
  let tags = $state<Tag[]>([]);
  let plans = $state<Plan[]>([]);

  // Defaults (user_settings)
  let quotaInput = $state('');
  let focusTagIds = $state<string[]>([]);

  // New-plan form
  let newPeriod = $state<PlanPeriod>('week');
  let newDate = $state('');
  let newQuota = $state('');
  let newFocusIds = $state<string[]>([]);
  let newNote = $state('');

  async function createTag(name: string): Promise<string> {
    const tag = await put('tags', withSyncFields({ name, notes_md: '' }));
    tags = [...tags, tag].sort((a, b) => a.name.localeCompare(b.name));
    return tag.id;
  }

  const today = new Date().toISOString().slice(0, 10);

  const tagName = $derived((id: string | null) => tags.find((t) => t.id === id)?.name ?? '—');

  const newStartsOn = $derived(newDate ? periodStart(newPeriod, newDate) : '');

  onMount(refresh);

  async function refresh() {
    const settings = await getUserSettings();
    quotaInput = settings?.articles_per_week ? String(settings.articles_per_week) : '';
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    // Drop focus tags that have since been deleted.
    focusTagIds = (settings ? focusIdsOf(settings) : []).filter((id) =>
      tags.some((t) => t.id === id)
    );
    plans = await listPlans();
    loading = false;
  }

  async function saveDefaults() {
    const quota = parseInt(quotaInput, 10);
    await saveUserSettings({
      articles_per_week: Number.isFinite(quota) && quota > 0 ? quota : null,
      focus_tag_ids: focusTagIds,
    });
    message = 'Defaults saved.';
  }

  async function addPlan(e: SubmitEvent) {
    e.preventDefault();
    if (!newDate) return;
    const quota = parseInt(newQuota, 10);
    await savePlan(newPeriod, newDate, {
      articles_per_week: Number.isFinite(quota) && quota > 0 ? quota : null,
      focus_tag_ids: newFocusIds,
      note: newNote.trim(),
    });
    message = 'Plan saved.';
    newDate = '';
    newQuota = '';
    newFocusIds = [];
    newNote = '';
    await refresh();
  }

  async function removePlan(plan: Plan) {
    if (!confirm(`Delete the ${plan.period} plan starting ${plan.starts_on}?`)) return;
    await deletePlan(plan.id);
    await refresh();
  }

  function planState(plan: Plan): 'past' | 'current' | 'upcoming' {
    if (periodEnd(plan) <= today) return 'past';
    if (plan.starts_on > today) return 'upcoming';
    return 'current';
  }

  function formatPeriod(plan: Plan): string {
    const d = new Date(`${plan.starts_on}T00:00:00`);
    if (plan.period === 'month') {
      return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    return `Week of ${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
  }
</script>

{#if loading}
  <p class="muted">Loading…</p>
{:else}
  <div class="stack">
    {#if message}
      <p class="notice">{message}</p>
    {/if}

    <Card title="Defaults">
      <p class="muted" style="margin-bottom: var(--space-3);">
        The quota and focus tag used whenever no plan below covers the week.
        The Reading List page suggests backlog links to fill the quota,
        preferring the focus tag.
      </p>
      <div>
        <label for="plan-quota">Articles per week (blank = off)</label>
        <input
          id="plan-quota"
          type="number"
          min="1"
          bind:value={quotaInput}
          onchange={saveDefaults}
          placeholder="e.g. 5"
        />
      </div>
      <div style="margin-top: var(--space-3);">
        <span class="field-label">Focus tags (quota splits across them)</span>
        <ChipSelect
          items={tags}
          bind:selected={focusTagIds}
          createPlaceholder="New tag…"
          onCreate={async (name) => {
            const id = await createTag(name);
            return id;
          }}
        />
        <button class="btn save-focus" onclick={saveDefaults}>Save focus tags</button>
      </div>
    </Card>

    <Card title="Scheduled plans">
      <p class="muted" style="margin-bottom: var(--space-3);">
        Plan upcoming weeks or months in advance — e.g. "next week is
        compilers, 3 articles". A weekly plan beats a monthly plan beats the
        defaults, field by field. Saving over the same period replaces it.
      </p>
      <form class="plan-form" onsubmit={addPlan}>
        <div class="row2">
          <div>
            <label for="plan-period">Period</label>
            <select id="plan-period" bind:value={newPeriod}>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </div>
          <div>
            <label for="plan-date">
              {newPeriod === 'week' ? 'Any day in that week' : 'Any day in that month'}
            </label>
            <input id="plan-date" type="date" bind:value={newDate} min="2020-01-01" />
          </div>
        </div>
        <div>
          <label for="plan-new-quota">Articles per week (blank = inherit)</label>
          <input id="plan-new-quota" type="number" min="1" bind:value={newQuota} placeholder="inherit" />
        </div>
        <div>
          <span class="field-label">Focus tags (none selected = inherit)</span>
          <ChipSelect
            items={tags}
            bind:selected={newFocusIds}
            createPlaceholder="New tag…"
            onCreate={createTag}
          />
        </div>
        <div>
          <label for="plan-note">Note (optional)</label>
          <input id="plan-note" type="text" bind:value={newNote} placeholder="e.g. compilers deep-dive" />
        </div>
        <div class="form-foot">
          {#if newStartsOn}
            <span class="muted">Will apply from {newStartsOn}</span>
          {/if}
          <button type="submit" class="btn btn-primary" disabled={!newDate}>Save plan</button>
        </div>
      </form>

      {#if plans.length === 0}
        <p class="empty">No scheduled plans yet.</p>
      {:else}
        <ul class="plan-list">
          {#each plans as plan (plan.id)}
            <li class:past={planState(plan) === 'past'}>
              <div class="plan-main">
                <span class="plan-period">
                  {formatPeriod(plan)}
                  {#if planState(plan) === 'current'}
                    <span class="badge">active</span>
                  {:else if planState(plan) === 'upcoming'}
                    <span class="badge upcoming">upcoming</span>
                  {/if}
                </span>
                <span class="plan-detail">
                  {plan.articles_per_week != null ? `${plan.articles_per_week}/week` : 'quota inherited'}
                  · focus: {focusIdsOf(plan).length > 0
                    ? focusIdsOf(plan).map(tagName).join(' + ')
                    : 'inherited'}
                  {#if plan.note}
                    · {plan.note}
                  {/if}
                </span>
              </div>
              <button class="btn btn-danger" onclick={() => removePlan(plan)}>Delete</button>
            </li>
          {/each}
        </ul>
      {/if}
    </Card>

    <p class="muted hint-week">
      The current week starts {currentWeekStart()} — see the
      <a href="../">Reading List</a> for what's in effect right now.
    </p>
  </div>
{/if}

<style>
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .notice {
    background: var(--color-primary-soft);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    margin: 0;
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

  .save-focus {
    margin-top: var(--space-2);
  }

  .plan-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--border-color);
    margin-bottom: var(--space-3);
  }

  .form-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .empty {
    color: var(--text-muted-color);
    text-align: center;
    padding: var(--space-4) 0;
  }

  .plan-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .plan-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--border-color);
  }

  .plan-list li:last-child {
    border-bottom: none;
  }

  .plan-list li.past {
    opacity: 0.55;
  }

  .plan-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .plan-period {
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .plan-detail {
    font-size: var(--font-size-sm);
    color: var(--text-muted-color);
  }

  .badge {
    background: var(--color-primary-soft);
    color: var(--color-primary-strong);
    border-radius: var(--radius-full);
    padding: 0 var(--space-2);
    font-size: var(--font-size-sm);
    font-weight: 700;
  }

  .badge.upcoming {
    background: transparent;
    border: 1px dashed var(--border-color);
    color: var(--text-muted-color);
  }

  .hint-week {
    margin: 0;
    text-align: center;
  }

  @media (max-width: 30rem) {
    .row2 {
      grid-template-columns: 1fr;
    }
  }
</style>
