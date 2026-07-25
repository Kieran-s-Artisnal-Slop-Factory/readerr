/** Repo locations, resolved from this file so tests run from any cwd. */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

/** frontend/ */
export const FRONTEND_DIR = path.resolve(here, '..', '..', '..');
/** repo root */
export const REPO_DIR = path.resolve(FRONTEND_DIR, '..');
/** backend/ (its own Go module) */
export const BACKEND_DIR = path.join(REPO_DIR, 'backend');
/** built frontend the Go server serves via STATIC_DIR */
export const DIST_DIR = path.join(FRONTEND_DIR, 'dist');
/** prebuilt test binaries (global-setup fills this) */
export const BIN_DIR = path.join(FRONTEND_DIR, 'tests', 'sync', '.bin');

const exe = process.platform === 'win32' ? '.exe' : '';
export const BACKEND_BIN = path.join(BIN_DIR, `readerr-backend${exe}`);
export const DBDUMP_BIN = path.join(BIN_DIR, `readerr-dbdump${exe}`);

/** Harness artifacts (results.json, report.html) — gitignored. */
export const RESULTS_DIR = path.join(FRONTEND_DIR, 'tests', 'sync', '.results');
