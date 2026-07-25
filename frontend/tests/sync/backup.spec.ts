/**
 * Backup / import + device lifecycle. Confirmed data-loss findings from the
 * audit are captured here as `test.fail` tripwires (red now → green after the
 * fix); the clean invariants that already hold are plain passing tests.
 *
 * The import paths are driven through the real export.ts service via the hook
 * so the shipped code is what runs.
 */
import { test, expect } from './helpers/devices';
import { hook, linkFixture, type SyncRow } from './helpers/hook';
import { propagate } from './helpers/roundtrip';

const iso = () => new Date().toISOString();

/** Run importData(envelope) inside the page against the real service. */
async function importInto(device: { page: import('@playwright/test').Page }, envelope: unknown) {
  return device.page.evaluate(async (env) => {
    const mod = (window as unknown as {
      __readerrExport?: { importData: (e: unknown) => Promise<unknown> };
    }).__readerrExport;
    if (!mod) throw new Error('export hook missing');
    return mod.importData(env);
  }, envelope);
}

// FIXED (export.ts): merge import now applies LWW; full restore resets the
// pull cursor + epoch. These were red tripwires; they are regression guards now.
test('merge import keeps a NEWER local row over an older backup row (LWW)', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  const fx = linkFixture({ title: 'current-newer' });
  const stamped = await A.repoPut('links', fx);
  const older = {
    ...stamped,
    title: 'stale-from-backup',
    updated_at: new Date(Date.parse(stamped.updated_at) - 60_000).toISOString(),
  };
  const envelope = { schemaVersion: 7, exportedAt: iso(), scope: 'curated', data: { links: [older] } };
  await importInto(deviceA, envelope);
  const after = (await A.rawGet('links', fx.id as string)) as SyncRow;
  expect(after.title).toBe('current-newer');
});

test('merge import DOES apply a NEWER backup row over an older local row (LWW)', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  const fx = linkFixture({ title: 'old-local' });
  const stamped = await A.repoPut('links', fx);
  const newer = {
    ...stamped,
    title: 'newer-from-backup',
    updated_at: new Date(Date.parse(stamped.updated_at) + 60_000).toISOString(),
  };
  const envelope = { schemaVersion: 7, exportedAt: iso(), scope: 'curated', data: { links: [newer] } };
  await importInto(deviceA, envelope);
  expect(((await A.rawGet('links', fx.id as string)) as SyncRow).title).toBe('newer-from-backup');
});

test('full restore resets lastPullSeq + serverEpoch so the device does not fork', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await A.syncNow(); // advances lastPullSeq + records serverEpoch
  const before = await A.getCursors();
  expect(before.lastPullSeq).toBeGreaterThan(0);
  const envelope = { schemaVersion: 7, exportedAt: iso(), scope: 'full', data: { links: [] } };
  await importInto(deviceA, envelope);
  const after = await A.getCursors();
  expect(after.lastPullSeq == null || after.lastPullSeq === 0).toBe(true);
  expect(after.serverEpoch).toBeNull();
});

test('poison guard: a backup row missing id/updated_at is rejected with no partial write', async ({
  deviceA,
}) => {
  const A = hook(deviceA);
  const good = linkFixture({ title: 'keep-me' });
  await A.repoPut('links', good);
  const envelope = {
    schemaVersion: 7,
    exportedAt: iso(),
    scope: 'curated',
    data: { links: [{ url: 'https://x', title: 'no-id-no-updated_at' }] },
  };
  let threw = false;
  try {
    await importInto(deviceA, envelope);
  } catch {
    threw = true;
  }
  expect(threw, 'malformed import should throw').toBe(true);
  // Nothing partial landed and the existing row is untouched.
  const links = (await A.rawDump('links')).filter((l) => !l.deleted_at);
  expect(links).toHaveLength(1);
  expect(links[0].id).toBe(good.id);
});

test('full restore clears foreign server_seq so restored rows re-push', async ({ deviceA }) => {
  const A = hook(deviceA);
  const envelope = {
    schemaVersion: 7,
    exportedAt: iso(),
    scope: 'full',
    data: { links: [linkFixture({ server_seq: 4242 })] },
  };
  await importInto(deviceA, envelope);
  const links = await A.rawDump('links');
  expect(links[0].server_seq, 'foreign seq nulled on restore').toBeNull();
});

test('full restore drops lastPushAt so restored rows re-push', async ({ deviceA }) => {
  const A = hook(deviceA);
  await A.repoPut('links', linkFixture());
  await A.setMeta('lastPushAt', iso());
  const envelope = { schemaVersion: 7, exportedAt: iso(), scope: 'full', data: { links: [linkFixture()] } };
  await importInto(deviceA, envelope);
  const cursors = await A.getCursors();
  expect(cursors.lastPushAt, 'lastPushAt dropped on restore').toBeNull();
});
