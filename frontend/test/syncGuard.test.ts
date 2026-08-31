/**
 * "Only sync when there's something to sync with."
 *
 * getSyncUrl() falls back to same-origin, which is right for the docker
 * deployment (one origin serves the frontend AND the sync API) and wrong for
 * every static install, where it turned each page load into a burst of failed
 * /healthz, /sync/stats, /sync/push, /feed and /title requests. The guard has
 * to keep the first case working while making the second silent, so these
 * tests pin both directions — and pin that the same-origin verdict is reached
 * with exactly ONE probe per session.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureSyncAvailable,
  hasValidSyncUrl,
  isValidSyncUrl,
  setSyncUrl,
  syncNow,
  NO_SERVER_MESSAGE,
} from '../src/lib/sync';

const localStore = new Map<string, string>();
const sessionStore = new Map<string, string>();

function shim(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
}

vi.stubGlobal('localStorage', shim(localStore));
vi.stubGlobal('sessionStorage', shim(sessionStore));
vi.stubGlobal('window', { dispatchEvent: () => {} });

beforeEach(() => {
  localStore.clear();
  sessionStore.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal('localStorage', shim(localStore));
  vi.stubGlobal('sessionStorage', shim(sessionStore));
  vi.stubGlobal('window', { dispatchEvent: () => {} });
});

describe('isValidSyncUrl', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['not a url', false],
    ['192.168.1.10:8080', false], // no scheme: parses as a "192.168.1.10:" URL
    ['ftp://example.com', false],
    ['javascript:alert(1)', false],
    ['/readerr', false], // the same-origin BASE_URL default is not an explicit URL
    ['http://localhost:8080', true],
    ['https://readerr.example.com', true],
    ['https://readerr.example.com/', true],
    ['http://192.168.1.10:8080/readerr', true],
  ])('%s -> %s', (url, expected) => {
    expect(isValidSyncUrl(url)).toBe(expected);
  });
});

describe('hasValidSyncUrl', () => {
  it('is false in offline mode even with a good URL saved', () => {
    setSyncUrl('https://readerr.example.com');
    localStorage.setItem('readerr-sync-mode', 'offline');
    expect(hasValidSyncUrl()).toBe(false);
  });

  it('is true for an explicitly saved http(s) URL', () => {
    setSyncUrl('http://192.168.1.10:8080');
    expect(hasValidSyncUrl()).toBe(true);
  });

  it('is false for a saved URL that is not a URL', () => {
    localStorage.setItem('readerr-sync-url', 'localhost:8080');
    expect(hasValidSyncUrl()).toBe(false);
  });

  it('ignores a trailing slash (setSyncUrl strips it)', () => {
    setSyncUrl('https://readerr.example.com/');
    expect(localStorage.getItem('readerr-sync-url')).toBe('https://readerr.example.com');
    expect(hasValidSyncUrl()).toBe(true);
  });

  it('assumes same-origin is usable until a probe says otherwise', () => {
    expect(hasValidSyncUrl()).toBe(true);
    sessionStorage.setItem('readerr-same-origin-sync', '0');
    expect(hasValidSyncUrl()).toBe(false);
    sessionStorage.setItem('readerr-same-origin-sync', '1');
    expect(hasValidSyncUrl()).toBe(true);
  });
});

describe('ensureSyncAvailable', () => {
  it('trusts an explicitly saved URL without probing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setSyncUrl('https://readerr.example.com');
    expect(await ensureSyncAvailable()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('probes same-origin /healthz once and remembers a live backend', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureSyncAvailable()).toBe(true);
    expect(await ensureSyncAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/healthz');
    expect(sessionStorage.getItem('readerr-same-origin-sync')).toBe('1');
  });

  it('probes once and remembers that a static host has no backend', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureSyncAvailable()).toBe(false);
    expect(await ensureSyncAvailable()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a network failure as no backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    expect(await ensureSyncAvailable()).toBe(false);
  });

  it('shares one probe between concurrent callers', async () => {
    const fetchMock = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b, c] = await Promise.all([
      ensureSyncAvailable(),
      ensureSyncAvailable(),
      ensureSyncAvailable(),
    ]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('judges an explicit argument on syntax alone (the Settings probe)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureSyncAvailable('http://192.168.1.10:8080')).toBe(true);
    expect(await ensureSyncAvailable('192.168.1.10:8080')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-probes after the configured URL changes', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await ensureSyncAvailable()).toBe(false);
    setSyncUrl('https://readerr.example.com');
    expect(await ensureSyncAvailable()).toBe(true);
    setSyncUrl('');
    expect(sessionStorage.getItem('readerr-same-origin-sync')).toBeNull();
  });
});

describe('syncNow with no server', () => {
  it('reports the missing server without issuing a sync request', async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL) => new Response('not found', { status: 404 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await syncNow();
    expect(result).toEqual({ ok: false, pushed: 0, pulled: 0, error: NO_SERVER_MESSAGE });
    // Only the /healthz probe — no /sync/stats, no /sync/push.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/healthz');
  });

  it('does not run at all in offline mode', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('readerr-sync-mode', 'offline');
    expect((await syncNow()).error).toBe(NO_SERVER_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
