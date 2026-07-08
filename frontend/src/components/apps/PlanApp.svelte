<script lang="ts">
  /**
   * Plan: the triage defaults (moved here from Settings) plus scheduled
   * weekly/monthly plans that override them when their period arrives.
   */
  import { onMount } from 'svelte';
  import Card from '../Card.svelte';
  import { all } from '../../lib/db/repo';
  import { getUserSettings, saveUserSettings } from '../../lib/services/settings';
  import { deletePlan, listPlans, periodEnd, periodStart, savePlan } from '../../lib/services/plans';
  import { currentWeekStart } from '../../lib/services/weeks';
  import type { Plan, PlanPeriod, Tag } from '../../lib/db/types';

  let loading = $state(true);
  let message = $state('');
  let tags = $state<Tag[]>([]);
  let plans = $state<Plan[]>([]);

  // Defaults (user_settings)
  let quotaInput = $state('');
  let focusTagInput = $state('');

  // New-plan form
  let newPeriod = $state<PlanPeriod>('week');
  let newDate = $state('');
  let newQuota = $state('');
  let newFocus = $state('');
  let newNote = $state('');

  const today = new Date().toISOString().slice(0, 10);

  const tagName = $derived((id: string | null) => tags.find((t) => t.id === id)?.name ?? '—');

  const newStartsOn = $derived(newDate ? periodStart(newPeriod, newDate) : '');

  onMount(refresh);

  async function refresh() {
    const settings = await getUserSettings();
    quotaInput = settings?.articles_per_week ? String(settings.articles_per_week) : '';
    focusTagInput = settings?.focus_tag_id ?? '';
    tags = (await all<Tag>('tags')).sort((a, b) => a.name.localeCompare(b.name));
    if (focusTagInput && !tags.some((t) => t.id === focusTagInput)) focusTagInput = '';
    plans = await listPlans();
    loading = false;
  }

  async function saveDefaults() {
    const quota = parseInt(quotaInput, 10);
    await saveUserSettings({
      articles_per_week: Number.isFinite(quota) && quota > 0 ? quota : null,
      focus_tag_id: focusTagInput || null,
    });
    message = 'Defaults saved.';
  }

  async function addPlan(e: SubmitEvent) {
    e.preventDefault();
    if (!newDate) return;
    const quota = parseInt(newQuota, 10);
    await savePlan(newPeriod, newDate, {
      articles_per_week: Number.isFinite(quota) && quota > 0 ? quota : null,
      focus_tag_id: newFocus || null,
      note: newNote.trim(),
    });
    message = 'Plan saved.';
    newDate = '';
    newQuota = '';
    newFocus = '';
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
        The This Week page suggests backlog links to fill the quota,
        preferring the focus tag.
      </p>
      <div class="row2">
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
        <div>
          <label for="plan-focus">Focus tag</label>
          <select id="plan-focus" bind:value={focusTagInput} onchange={saveDefaults}>
            <option value="">None</option>
            {#each tags as tag (tag.id)}
              <option value={tag.id}>{tag.name}</option>
            {/each}
          </select>
        </div>
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
        <div class="row2">
          <div>
            <label for="plan-new-quota">Articles per week (blank = inherit)</label>
            <input id="plan-new-quota" type="number" min="1" bind:value={newQuota} placeholder="inherit" />
          </div>
          <div>
            <label for="plan-new-focus">Focus tag (blank = inherit)</label>
            <select id="plan-new-focus" bind:value={newFocus}>
              <option value="">Inherit</option>
              {#each tags as tag (tag.id)}
                <option value={tag.id}>{tag.name}</option>
              {/each}
            </select>
          </div>
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
                  · focus: {plan.focus_tag_id ? tagName(plan.focus_tag_id) : 'inherited'}
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
      The current week starts {currentWeekStart()} — see
      <a href="../week/">This Week</a> for what's in effect right now.
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
