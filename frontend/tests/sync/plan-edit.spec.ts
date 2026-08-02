/**
 * Editing scheduled plans THROUGH THE REAL UI, on the real built app, then
 * syncing the result to a second device.
 *
 * The unit tests (test/planEdit.test.ts) cover the service semantics; these
 * cover the parts only a browser can: that the Edit control exists on both
 * pages, that the form is seeded with the plan's current values, that saving
 * writes what was typed, and that the edit converges.
 */
import { test, expect } from './helpers/devices';
import { bootDevice } from './helpers/devices';
import { hook, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';
import { snapshotThreeWay, assertThreeWayConverged } from './helpers/oracle';

const iso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();

/** Monday of the current week, computed the same way the app does. */
function currentMonday(): string {
  const d = new Date();
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  local.setDate(local.getDate() - ((local.getDay() + 6) % 7));
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const dd = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${m}-${dd}`;
}

function mondayPlus(weekStart: string, weeks: number): string {
  const d = new Date(`${weekStart}T00:00:00`);
  d.setDate(d.getDate() + 7 * weeks);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${dd}`;
}

function planRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uid(),
    updated_at: iso(),
    deleted_at: null,
    server_seq: null,
    period: 'week',
    starts_on: currentMonday(),
    articles_per_week: 3,
    focus_tag_ids: [],
    note: 'original note',
    ...over,
  };
}

test('store:plans Automation page edits a plan in place and it converges to B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const plan = await A.repoPut('plans', planRow({ articles_per_week: 3, note: 'original note' }));
  await propagate(deviceA, deviceB);

  await bootDevice(deviceA, backend.baseUrl, '/plan/');
  const page = deviceA.page;

  // The plan is listed with its current values.
  await expect(page.getByText('original note')).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();

  // Scoped to the editor: the page also carries the "New plan" form, whose
  // fields share these labels.
  const editor = page.getByRole('form', { name: 'Edit plan' });
  // The editor is seeded from the plan, not blank.
  const quota = editor.getByLabel('Articles per week (blank = inherit)');
  await expect(quota).toHaveValue('3');
  const note = editor.getByLabel('Note (optional)');
  await expect(note).toHaveValue('original note');

  await quota.fill('9');
  await note.fill('rewritten note');
  await editor.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText('Plan updated.')).toBeVisible();
  await expect(page.getByText('rewritten note')).toBeVisible();

  // Persisted on the same row (an edit, not a second plan).
  const rows = (await A.rawDump('plans')).filter((p) => !p.deleted_at);
  expect(rows, 'still exactly one plan').toHaveLength(1);
  expect(rows[0].id).toBe(plan.id);
  expect(rows[0].articles_per_week).toBe(9);
  expect(rows[0].note).toBe('rewritten note');

  await propagate(deviceA, deviceB);
  const onB = (await B.rawGet('plans', plan.id as string)) as SyncRow;
  expect(onB.articles_per_week, 'B sees the new quota').toBe(9);
  expect(onB.note, 'B sees the new note').toBe('rewritten note');

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['plans'] });
});

test('store:plans Automation page moves a plan to another week, leaving one row', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  const from = currentMonday();
  const to = mondayPlus(from, 3);
  const plan = await A.repoPut('plans', planRow({ starts_on: from, note: 'moving' }));
  await propagate(deviceA, deviceB);

  await bootDevice(deviceA, backend.baseUrl, '/plan/');
  const page = deviceA.page;
  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.getByRole('form', { name: 'Edit plan' });
  await editor.getByLabel('Any day in that week').fill(to);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Plan moved.')).toBeVisible();

  const live = (await A.rawDump('plans')).filter((p) => !p.deleted_at);
  expect(live, 'the old row is tombstoned, not left behind').toHaveLength(1);
  expect(live[0].starts_on).toBe(to);
  expect(live[0].note).toBe('moving');

  // B must end up with the same single live plan — the move has to carry the
  // tombstone across, or B keeps a ghost plan governing the old week.
  await propagate(deviceA, deviceB);
  const liveOnB = (await B.rawDump('plans')).filter((p) => !p.deleted_at);
  expect(liveOnB, 'B has one live plan too').toHaveLength(1);
  expect(liveOnB[0].starts_on).toBe(to);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['plans'] });
  // Whatever happened, the original row must not still be live anywhere.
  const original = (await B.rawGet('plans', plan.id as string)) as SyncRow | undefined;
  if (original && original.starts_on === from) {
    expect(original.deleted_at, 'the vacated row is tombstoned on B').toBeTruthy();
  }
});

test('store:plans Upcoming weeks creates a week plan and it converges to B', async ({
  backend,
  deviceA,
  deviceB,
}) => {
  const A = hook(deviceA);
  const B = hook(deviceB);

  await bootDevice(deviceA, backend.baseUrl, '/upcoming/');
  const page = deviceA.page;

  // The panel defaults to next week and has no plan of its own yet.
  await expect(page.getByRole('button', { name: 'Plan this week' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan this week' }).click();

  const editor = page.getByRole('form', { name: 'Week plan' });
  await editor.getByLabel('Articles per week (blank = inherit)').fill('6');
  await editor.getByLabel('Note (optional)').fill('planned from upcoming');
  await editor.getByRole('button', { name: 'Create week plan' }).click();

  // It now has its own plan, and the control flips to editing it.
  await expect(page.getByRole('button', { name: 'Edit plan' })).toBeVisible();

  const rows = (await A.rawDump('plans')).filter((p) => !p.deleted_at);
  expect(rows).toHaveLength(1);
  expect(rows[0].period, 'a WEEK plan, never the governing month').toBe('week');
  expect(rows[0].starts_on).toBe(mondayPlus(currentMonday(), 1));
  expect(rows[0].articles_per_week).toBe(6);
  expect(rows[0].note).toBe('planned from upcoming');

  await propagate(deviceA, deviceB);
  const onB = (await B.rawGet('plans', rows[0].id as string)) as SyncRow;
  expect(onB.articles_per_week).toBe(6);

  const snap = await snapshotThreeWay(backend, deviceA, deviceB);
  assertThreeWayConverged(snap, { stores: ['plans'] });
});

test('store:plans Upcoming weeks overrides a monthly plan for one week only', async ({
  backend,
  deviceA,
}) => {
  const A = hook(deviceA);
  const nextWeek = mondayPlus(currentMonday(), 1);
  const monthStart = `${nextWeek.slice(0, 7)}-01`;

  const monthly = await A.repoPut(
    'plans',
    planRow({ period: 'month', starts_on: monthStart, articles_per_week: 2, note: 'the month' })
  );

  await bootDevice(deviceA, backend.baseUrl, '/upcoming/');
  const page = deviceA.page;

  // The panel says the week is inheriting, and offers to override it.
  await expect(page.getByText(/saving here overrides this week only/i)).toBeVisible();
  await page.getByRole('button', { name: 'Plan this week' }).click();
  // Seeded from what is currently in effect — the monthly quota.
  const editor = page.getByRole('form', { name: 'Week plan' });
  await expect(editor.getByLabel('Articles per week (blank = inherit)')).toHaveValue('2');
  await editor.getByLabel('Articles per week (blank = inherit)').fill('8');
  await editor.getByRole('button', { name: 'Create week plan' }).click();
  await expect(page.getByRole('button', { name: 'Edit plan' })).toBeVisible();

  const live = (await A.rawDump('plans')).filter((p) => !p.deleted_at);
  expect(live, 'the monthly plan survives alongside the new week plan').toHaveLength(2);
  const month = live.find((p) => p.id === monthly.id)!;
  expect(month.articles_per_week, 'the month was NOT retuned').toBe(2);
  expect(month.note).toBe('the month');
  const week = live.find((p) => p.period === 'week')!;
  expect(week.starts_on).toBe(nextWeek);
  expect(week.articles_per_week).toBe(8);
});
