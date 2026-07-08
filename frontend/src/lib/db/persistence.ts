/**
 * Persistent-storage request. Browsers treat IndexedDB as evictable cache
 * (iOS Safari wipes it after ~7 days of inactivity unless installed as a
 * PWA), and until sync ships this is the only copy of the data — so ask for
 * the persistent bucket on first launch and surface the answer.
 */
export type PersistState = 'granted' | 'denied' | 'unsupported';

export async function requestPersistentStorage(): Promise<PersistState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return 'unsupported';
  }
  if (await navigator.storage.persisted()) return 'granted';
  return (await navigator.storage.persist()) ? 'granted' : 'denied';
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
