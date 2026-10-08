import { log } from '@/diagnostics/logger';
import type { RegistrySnapshot } from './schema';

/**
 * The offline seed registry.
 *
 * A build-time capture of both live indexes, normalised by the same converter
 * the app uses at runtime and shipped as `bundled-registry.json.gz`. It exists
 * because a first launch with no network currently knows about nothing, and
 * because the community index is an undocumented endpoint rather than a
 * published API — "it will always be there" is not a safe assumption.
 *
 * It is a **fallback, not a source**. The bundles it carries keep their real
 * `sourceId` values (`official`, `community`), which is what lets the existing
 * sync logic treat it correctly without any special casing: a successful fetch
 * replaces it, and a failed fetch keeps it for that source only. Stale data is
 * therefore visible rather than silent — the versions it lists are simply older.
 *
 * Why this file is not imported as a module: it is 4.7 MB of JSON, and a static
 * import would put it in the JS bundle. Fetched from `public/` and inflated at
 * runtime, it costs nothing at startup unless it is actually needed.
 */

/**
 * Deliberately not `bundled-registry.json.gz`.
 *
 * AAPT2 decompresses any asset whose name ends in `.gz` at package time and
 * drops the extension, so the runtime name would not match what was requested
 * and the fetch would 404 — silently, because this whole module degrades to
 * "no seed" rather than failing. The bytes are still gzip.
 */
const SEED_URL = 'bundled-registry.seed';

/** One inflate per process; the store and any diagnostics both ask for it. */
let pending: Promise<RegistrySnapshot | null> | null = null;

export function loadBundledSnapshot(): Promise<RegistrySnapshot | null> {
  pending ??= inflate();
  return pending;
}

async function inflate(): Promise<RegistrySnapshot | null> {
  const started = performance.now();

  try {
    const response = await fetch(SEED_URL, { cache: 'force-cache' });
    if (!response.ok) {
      log.warn('seed', `No bundled registry at ${SEED_URL} (HTTP ${response.status})`);
      return null;
    }

    const bytes = await response.arrayBuffer();
    const text = await gunzip(bytes);
    const snapshot = JSON.parse(text) as RegistrySnapshot;

    if (!Array.isArray(snapshot.bundles) || snapshot.bundles.length === 0) {
      log.warn('seed', 'Bundled registry parsed but contains no bundles');
      return null;
    }

    const packages = new Set(snapshot.bundles.flatMap((b) => b.targetApps));
    log.info(
      'seed',
      `Loaded the bundled registry: ${snapshot.bundles.length} bundles, ${packages.size} packages`,
      { bytes: bytes.byteLength, ms: Math.round(performance.now() - started) },
    );
    return snapshot;
  } catch (error) {
    // Never fatal: the network sync is the primary path and this is a nicety.
    log.warn('seed', 'Could not load the bundled registry; starting empty', error);
    return null;
  }
}

/**
 * `DecompressionStream` is the platform gzip implementation — no bundled
 * inflate library, no eval, and it runs off the main thread inside the stream
 * pipeline. It landed in Chromium 80, comfortably below anything Capacitor 7
 * supports; the guard is for the Node-based tooling paths and exotic WebViews.
 */
async function gunzip(bytes: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable in this runtime');
  }

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
