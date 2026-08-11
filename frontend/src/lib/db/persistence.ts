/**
 * Persistent-storage request. Browsers treat IndexedDB as evictable cache
 * (iOS Safari wipes it after ~7 days of inactivity unless installed as a
 * PWA), and on offline-mode or never-synced devices it holds the only copy
 * of the data — so ask for the persistent bucket on first launch and
 * surface the answer.
 */
export type PersistState = 'granted' | 'denied' | 'unsupported';

export async function requestPersistentStorage(): Promise<PersistState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return 'unsupported';
  }
  if (await navigator.storage.persisted()) return 'granted';
  return (await navigator.storage.persist()) ? 'granted' : 'denied';
}
