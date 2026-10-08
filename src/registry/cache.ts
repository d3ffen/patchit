import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { RegistrySnapshot } from './schema';

/**
 * Offline-first storage.
 *
 * The community index alone is ~2 MB of JSON. Two consequences shape this file:
 *
 *  1. Re-downloading it on every launch is unacceptable on mobile data, so we
 *     store the raw body *and* its ETag and revalidate conditionally. A 304
 *     costs a few hundred bytes.
 *  2. Parsing 2 MB into 200 bundles is ~100 ms of main-thread work. We cache the
 *     *parsed* snapshot too, so a cold start reads one object instead of
 *     re-parsing. The raw body stays around only so a revalidation miss can be
 *     re-parsed without a re-download.
 *
 * IndexedDB rather than localStorage because localStorage is synchronous, caps
 * out around 5 MB, and stores strings — two of those three are fatal here.
 */

const DB_NAME = 'morphe-patch-scanner';
const DB_VERSION = 1;

export interface HttpCacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  status: number;
  body: string;
}

export interface IconCacheEntry {
  /** `${packageName}@${size}` */
  key: string;
  dataUrl: string;
  cachedAt: number;
}

interface MorpheDB extends DBSchema {
  http: {
    key: string;
    value: HttpCacheEntry;
  };
  registry: {
    key: string;
    value: { id: string; snapshot: RegistrySnapshot; savedAt: number };
  };
  icons: {
    key: string;
    value: IconCacheEntry;
  };
  kv: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<MorpheDB>> | null = null;

function getDB(): Promise<IDBPDatabase<MorpheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<MorpheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('http')) db.createObjectStore('http', { keyPath: 'url' });
        if (!db.objectStoreNames.contains('registry')) db.createObjectStore('registry', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('icons')) db.createObjectStore('icons', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      },
      blocked() {
        console.warn('[cache] another tab is holding an older schema version');
      },
    });
  }
  return dbPromise;
}

/* ------------------------------------------------------------------ *
 * Raw HTTP cache (ETag revalidation)
 * ------------------------------------------------------------------ */

export async function readHttpCache(url: string): Promise<HttpCacheEntry | undefined> {
  return (await getDB()).get('http', url);
}

export async function writeHttpCache(entry: HttpCacheEntry): Promise<void> {
  // Keep the body only for index-shaped responses; icon blobs have their own
  // store and should never land here.
  await (await getDB()).put('http', entry);
}

export async function clearHttpCache(): Promise<void> {
  await (await getDB()).clear('http');
}

/* ------------------------------------------------------------------ *
 * Parsed snapshot
 * ------------------------------------------------------------------ */

const SNAPSHOT_ID = 'snapshot';

export async function readSnapshot(): Promise<RegistrySnapshot | null> {
  const row = await (await getDB()).get('registry', SNAPSHOT_ID);
  return row?.snapshot ?? null;
}

export async function writeSnapshot(snapshot: RegistrySnapshot): Promise<void> {
  await (await getDB()).put('registry', {
    id: SNAPSHOT_ID,
    snapshot,
    savedAt: Date.now(),
  });
}

export async function clearSnapshot(): Promise<void> {
  await (await getDB()).delete('registry', SNAPSHOT_ID);
}

/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

export async function readIcon(packageName: string, size: number): Promise<string | null> {
  const row = await (await getDB()).get('icons', `${packageName}@${size}`);
  return row?.dataUrl ?? null;
}

export async function writeIcons(entries: IconCacheEntry[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('icons', 'readwrite');
  await Promise.all(entries.map((e) => tx.store.put(e)));
  await tx.done;
}

/* ------------------------------------------------------------------ *
 * Key/value (settings, source list, seen-versions snapshots)
 * ------------------------------------------------------------------ */

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const value = await (await getDB()).get('kv', key);
  return (value as T | undefined) ?? fallback;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await getDB()).put('kv', value, key);
}

/* ------------------------------------------------------------------ *
 * Maintenance
 * ------------------------------------------------------------------ */

export async function estimateUsage(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function persistStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  // Android can evict an origin's storage under pressure. Asking for a
  // persistent grant keeps the offline registry alive.
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
