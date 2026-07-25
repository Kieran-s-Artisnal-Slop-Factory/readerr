/**
 * Build everything the suite runs against, once per invocation:
 *   - the production frontend bundle (frontend/dist) the Go server serves —
 *     the REAL code path, service worker included; and
 *   - the backend + dbdump binaries (prebuilt so teardown kills one PID, not
 *     a `go run` parent+child, and so Windows teardown is deterministic).
 *
 * READERR_SKIP_BUILD=1 skips both for fast local iteration when neither the
 * app nor the backend changed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { BACKEND_BIN, BACKEND_DIR, BIN_DIR, DBDUMP_BIN, DIST_DIR, FRONTEND_DIR } from './helpers/paths';

const run = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  if (process.env.READERR_SKIP_BUILD === '1') {
    if (!(await exists(DIST_DIR)) || !(await exists(BACKEND_BIN)) || !(await exists(DBDUMP_BIN))) {
      throw new Error('READERR_SKIP_BUILD=1 but a build artifact is missing — run once without it');
    }
    return;
  }

  console.log('[sync-tests] building frontend (production bundle)…');
  await run('npm', ['run', 'build'], { cwd: FRONTEND_DIR, shell: process.platform === 'win32' });

  console.log('[sync-tests] building backend + dbdump binaries…');
  await fs.mkdir(BIN_DIR, { recursive: true });
  await run('go', ['build', '-o', BACKEND_BIN, '.'], { cwd: BACKEND_DIR });
  await run('go', ['build', '-o', DBDUMP_BIN, './cmd/dbdump'], { cwd: BACKEND_DIR });
}
