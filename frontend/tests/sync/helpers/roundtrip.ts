/**
 * Field round-trip driver: write a value on A, push, confirm the server (both
 * legs) then pull to B, and assert the field arrived TYPE-EXACT and equal to
 * the INTENDED value — not merely that A, B and the server agree. (Three-way
 * agreement is necessary but not sufficient: a field nulled on push makes the
 * server store null, A pulls its own row back and overwrites its local value,
 * and all three then "agree" on the erased value. The intended-value check is
 * what catches that; the reconciliation audit proved it is a live risk.)
 */
import { expect } from '@playwright/test';
import type { BackendHandle } from './backend';
import type { Device } from './devices';
import { hook, type SyncRow } from './hook';
import { diffValues } from './compare';
import { normalizeStoredRow } from './meta';

/** Push everything dirty on `from`, then pull it onto `to`. */
export async function propagate(from: Device, to: Device): Promise<void> {
  const push = await hook(from).syncNow();
  expect(push.ok, `push failed: ${push.error}`).toBe(true);
  const pull = await hook(to).syncNow();
  expect(pull.ok, `pull failed: ${pull.error}`).toBe(true);
}

export interface RoundTripExpectation {
  store: string;
  id: string;
  field: string;
  /** The value the harness intends the field to hold, type-exact. */
  value: unknown;
}

/**
 * Assert a field holds the intended value+type on device B AND on both server
 * legs. Call after propagate(A, B).
 */
export async function expectFieldRoundTrip(
  backend: BackendHandle,
  deviceB: Device,
  exp: RoundTripExpectation
): Promise<void> {
  const onB = (await hook(deviceB).rawGet(exp.store, exp.id)) as SyncRow | undefined;
  expect(onB, `${exp.store}/${exp.id} missing on B`).toBeTruthy();
  fieldEqual(`B ${exp.store}.${exp.field}`, exp.value, onB![exp.field]);

  const served = await backend.pullAll();
  const servedRow = (served.rows[exp.store] ?? []).find((r) => r.id === exp.id);
  expect(servedRow, `${exp.store}/${exp.id} not served`).toBeTruthy();
  fieldEqual(`server(served) ${exp.store}.${exp.field}`, exp.value, servedRow![exp.field]);

  const stored = await backend.dumpSqlite();
  const storedRaw = (stored[exp.store] ?? []).find((r) => r.id === exp.id);
  expect(storedRaw, `${exp.store}/${exp.id} not stored`).toBeTruthy();
  const normalized = normalizeStoredRow(exp.store, storedRaw!);
  fieldEqual(`server(stored) ${exp.store}.${exp.field}`, exp.value, normalized[exp.field]);
}

function fieldEqual(label: string, expected: unknown, actual: unknown): void {
  const diffs = diffValues(expected, actual);
  expect(
    diffs,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  ).toEqual([]);
}
