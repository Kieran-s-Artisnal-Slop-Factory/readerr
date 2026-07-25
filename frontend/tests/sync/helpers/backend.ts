/**
 * One real Go backend per test file: fresh sqlite database in a temp dir,
 * ephemeral port, serving the production frontend build (STATIC_DIR) so both
 * device contexts load the exact same-origin topology we ship. Teardown is
 * Windows-aware: the sqlite file (and -wal/-shm) can stay locked briefly
 * after the process dies, so deletion retries with backoff and a leftover
 * temp file never fails a test.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BACKEND_BIN, DBDUMP_BIN, DIST_DIR } from './paths';

const execFileAsync = promisify(execFile);

export interface BackendHandle {
  /** http://127.0.0.1:<port> — the origin both devices load. */
  baseUrl: string;
  port: number;
  dbPath: string;
  /** Captured stdout+stderr (JSON slog lines) for debugging/assertions. */
  log: () => string;
  /**
   * The oracle's "server STORES" leg: a direct read of the sqlite file via
   * the dbdump binary — raw values (bools as 0/1, JSON columns as text),
   * independent of the server's own /sync/pull serialization.
   */
  dumpSqlite: () => Promise<Record<string, Record<string, unknown>[]>>;
  /** The oracle's "server SERVES" leg: GET /sync/pull?since=0, parsed. */
  pullAll: () => Promise<{ rows: Record<string, Record<string, unknown>[]>; latestSeq: number; epoch?: string }>;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port assigned')));
      }
    });
  });
}

async function waitHealthy(baseUrl: string, proc: ChildProcess, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  proc.once('exit', () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`backend exited before becoming healthy`);
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`backend did not report healthy within ${timeoutMs}ms`);
}

/** Delete a directory, retrying over Windows file-lock lag. Never throws. */
async function rmWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  // Leftover temp files are not worth failing a test run over.
}

export async function startBackend(): Promise<BackendHandle> {
  const port = await freePort();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'readerr-sync-'));
  const dbPath = path.join(tmpDir, 'readerr.db');
  const baseUrl = `http://127.0.0.1:${port}`;

  let log = '';
  const proc = spawn(BACKEND_BIN, [], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      PORT: String(port),
      STATIC_DIR: DIST_DIR,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (log += d.toString()));

  try {
    await waitHealthy(baseUrl, proc);
  } catch (err) {
    proc.kill();
    await rmWithRetry(tmpDir);
    throw new Error(`${String(err)}\nbackend log:\n${log}`);
  }

  return {
    baseUrl,
    port,
    dbPath,
    log: () => log,
    dumpSqlite: async () => {
      const { stdout } = await execFileAsync(DBDUMP_BIN, ['-db', dbPath], {
        maxBuffer: 256 * 1024 * 1024,
      });
      return JSON.parse(stdout) as Record<string, Record<string, unknown>[]>;
    },
    pullAll: async () => {
      const res = await fetch(`${baseUrl}/sync/pull?since=0`);
      if (!res.ok) throw new Error(`pullAll: ${res.status} ${res.statusText}`);
      return (await res.json()) as {
        rows: Record<string, Record<string, unknown>[]>;
        latestSeq: number;
        epoch?: string;
      };
    },
    stop: async () => {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
      proc.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
      await rmWithRetry(tmpDir);
    },
  };
}
