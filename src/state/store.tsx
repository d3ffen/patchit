import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppScanner, MorpheBridge } from '@/native/plugins';
import type { InstalledApp, MorpheInstall } from '@/native/types';
import { buildIndex, evaluateAll, type AppMatch, type RegistryIndex } from '@/core/compatibility';
import { log } from '@/diagnostics/logger';
import { kvGet, kvSet, persistStorage, readSnapshot, readIcon, writeIcons } from '@/registry/cache';import { httpGet } from '@/registry/http';
import { loadBundledSnapshot } from '@/registry/seed';
import { checkForUpdate, type UpdateState } from '@/native/updater';
import { defaultSources, makeCustomSource, resolveInput } from '@/registry/sources';
import { syncRegistry, type SyncProgress } from '@/registry/sync';
import type { PatchSource, RegistrySnapshot } from '@/registry/schema';

/**
 * Application store.
 *
 * Kept as a single context with `useState` rather than pulling in a state
 * library, because there is exactly one writer for each slice and the whole
 * thing fits in a few hundred lines. What matters for performance is not the
 * state container but *where the derived work happens*, and that is what the
 * memo boundaries below are for:
 *
 *   snapshot  -> index            (rebuilt only when the registry changes)
 *   apps      -> matches          (rebuilt only when apps or index change)
 *   matches   -> filtered list    (rebuilt only when the filter changes)
 *
 * The expensive step is `evaluateAll`: ~300 apps x ~30 patches. Recomputing it
 * on every keystroke in the search box is the difference between a snappy list
 * and a stuttering one.
 */

export interface Filters {
  /** Free-text query over package name and label. */
  query: string;
  /** Show only apps with at least one usable patch. */
  patchableOnly: boolean;
  /** Include apps flagged as system. */
  includeSystem: boolean;
  /** Include split (APKM/APKS) installs. */
  includeSplits: boolean;
  /** How to sort the list. */
  sort: 'name' | 'verdict' | 'patches';
}

const DEFAULT_FILTERS: Filters = {
  query: '',
  patchableOnly: true,
  includeSystem: false,
  includeSplits: true,
  sort: 'name',
};

const FILTERS_KEY = 'apps.filters';
const SOURCES_KEY = 'registry.sources';

/**
 * Where the current snapshot came from. Surfaced in the diagnostics screen so a
 * stale registry is visible rather than something to be inferred from old
 * version numbers.
 */
export type SnapshotOrigin = 'live' | 'bundled';

export interface StoreValue {
  ready: boolean;
  /** The diagnostics viewer is a full-screen overlay, not a tab. */
  logsOpen: boolean;
  setLogsOpen: (open: boolean) => void;
  syncing: boolean;
  scanning: boolean;
  syncProgress: SyncProgress | null;
  snapshot: RegistrySnapshot | null;
  snapshotOrigin: SnapshotOrigin | null;
  sources: PatchSource[];
  apps: InstalledApp[];
  matches: AppMatch[];
  filteredMatches: AppMatch[];
  index: RegistryIndex | null;
  filters: Filters;
  setFilters: (next: Partial<Filters>) => void;
  morpheInstalls: MorpheInstall[];
  scanMeta: { durationMs: number; fullVisibility: boolean; skipped: number; deviceSdk: number } | null;
  lastScanAt: number | null;
  lastSyncAt: number | null;
  error: string | null;
  /** Latest-release state, checked once on launch and on demand. */
  update: UpdateState;

  sync: (options?: { force?: boolean }) => Promise<void>;
  recheckUpdate: () => void;
  rescan: () => Promise<void>;
  addSource: (input: string) => Promise<{ ok: boolean; message: string }>;
  removeSource: (id: string) => Promise<void>;
  toggleSource: (id: string) => Promise<void>;
  loadIcon: (packageName: string, size?: number) => Promise<string | null>;
  findMorphe: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

const ICON_SIZE = 128;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [snapshot, setSnapshot] = useState<RegistrySnapshot | null>(null);
  const [snapshotOrigin, setSnapshotOrigin] = useState<SnapshotOrigin | null>(null);
  const [sources, setSources] = useState<PatchSource[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [filters, setFiltersState] = useState<Filters>(DEFAULT_FILTERS);
  const [morpheInstalls, setMorpheInstalls] = useState<MorpheInstall[]>([]);
  const [scanMeta, setScanMeta] = useState<StoreValue['scanMeta']>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });

  // Icons are held outside React state: a 300-entry map of data URIs would make
  // every unrelated state change expensive to diff.
  const iconCache = useRef(new Map<string, string>());
  const snapshotRef = useRef<RegistrySnapshot | null>(null);
  snapshotRef.current = snapshot;

  /* --- Boot ---------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      try {
        void persistStorage();

        const [storedSources, storedFilters, cached] = await Promise.all([
          kvGet<PatchSource[] | null>(SOURCES_KEY, null),
          kvGet<Filters>(FILTERS_KEY, DEFAULT_FILTERS),
          readSnapshot(),
        ]);
        if (cancelled) return;

        const nextSources = storedSources && storedSources.length > 0 ? storedSources : defaultSources();
        setSources(nextSources);
        setFiltersState({ ...DEFAULT_FILTERS, ...storedFilters });

        if (cached) {
          setSnapshot(cached);
          setSnapshotOrigin('live');
          setLastSyncAt(cached.fetchedAt);
          log.info('store', 'Loaded the cached registry', {
            bundles: cached.bundles.length,
            ageMinutes: Math.round((Date.now() - cached.fetchedAt) / 60_000),
          });
        } else {
          // First launch, nothing cached. Seed from the bundled capture so the
          // app list is populated immediately instead of showing an empty state
          // until the network answers — or forever, if it never does.
          //
          // Deliberately not written to IndexedDB: the cache is for *synced*
          // data, and keeping the seed out of it means a later launch still
          // prefers a real sync while falling back here again on failure.
          const seeded = await loadBundledSnapshot();
          if (cancelled) return;
          if (seeded) {
            setSnapshot(seeded);
            setSnapshotOrigin('bundled');
          }
        }
        setReady(true);
      } catch (bootError) {
        log.error('store', 'Boot failed', bootError);
        setError(bootError instanceof Error ? bootError.message : String(bootError));
        setReady(true);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- Derived state -------------------------------------------------- */
  const index = useMemo(() => (snapshot ? buildIndex(snapshot) : null), [snapshot]);

  const matches = useMemo(() => {
    if (!index) return [];
    const started = performance.now();
    const result = evaluateAll(apps, index);
    const elapsed = performance.now() - started;
    if (apps.length > 0) {
      log.debug('store', `Evaluated ${apps.length} apps in ${elapsed.toFixed(0)} ms`, {
        withPatches: result.filter((m) => m.verdict !== 'no-patches').length,
      });
    }
    return result;
  }, [apps, index]);

  const filteredMatches = useMemo(() => {
    const query = filters.query.trim().toLowerCase();
    const filtered = matches.filter((match) => {
      if (filters.patchableOnly && match.verdict === 'no-patches') return false;
      if (!filters.includeSystem && match.app.isSystem && !match.app.isUpdatedSystemApp) return false;
      if (!filters.includeSplits && match.app.hasSplits) return false;
      if (query) {
        const haystack = `${match.app.label} ${match.app.packageName}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const verdictRank: Record<string, number> = {
      supported: 0,
      experimental: 1,
      unlisted: 2,
      'too-old': 3,
      'too-new': 4,
      'no-patches': 5,
    };

    return filtered.sort((a, b) => {
      switch (filters.sort) {
        case 'verdict': {
          const delta = verdictRank[a.verdict] - verdictRank[b.verdict];
          if (delta !== 0) return delta;
          return a.app.label.localeCompare(b.app.label);
        }
        case 'patches': {
          const delta = b.usablePatchCount - a.usablePatchCount;
          if (delta !== 0) return delta;
          return a.app.label.localeCompare(b.app.label);
        }
        case 'name':
        default:
          return a.app.label.localeCompare(b.app.label);
      }
    });
  }, [matches, filters]);

  /* --- Actions -------------------------------------------------------- */

  const rescan = useCallback(async () => {
    setScanning(true);
    setError(null);
    log.info('scan', 'Scanning installed packages');
    try {
      const result = await AppScanner.scan({
        includeSystem: filters.includeSystem,
        includeSplits: filters.includeSplits,
      });
      setApps(result.apps);
      setScanMeta({
        durationMs: result.durationMs,
        fullVisibility: result.fullVisibility,
        skipped: result.skipped.length,
        deviceSdk: result.deviceSdk,
      });
      setLastScanAt(Date.now());
      log.info('scan', `Found ${result.apps.length} packages in ${result.durationMs} ms`, {
        skipped: result.skipped.slice(0, 8),
        fullVisibility: result.fullVisibility,
      });
      if (!result.fullVisibility) {
        log.warn(
          'scan',
          'Package visibility looks incomplete — QUERY_ALL_PACKAGES may not be granted',
        );
      }
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : String(scanError);
      setError(message);
      log.error('scan', 'Package scan failed', scanError);
    } finally {
      setScanning(false);
    }
  }, [filters.includeSystem, filters.includeSplits]);

  const sync = useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      setSyncing(true);
      setError(null);
      log.info('sync', force ? 'Forced registry sync' : 'Registry sync');

      try {
        const report = await syncRegistry({
          sources,
          previous: snapshotRef.current,
          onProgress: setSyncProgress,
        });

        setSnapshot(report.snapshot);
        setSnapshotOrigin('live');
        setSources((current) =>
          current.map((source) => {
            const result = report.perSource.find((r) => r.sourceId === source.id);
            if (!result) return source;
            return {
              ...source,
              lastSyncAt: result.ok ? Date.now() : source.lastSyncAt,
              lastSyncError: result.error,
              bundleCount: result.bundleCount,
              patchCount: result.patchCount,
            };
          }),
        );
        setLastSyncAt(Date.now());

        for (const result of report.perSource) {
          if (result.ok && !result.notModified) {
            log.info(
              'sync',
              `${result.name}: ${result.bundleCount} bundles, ${result.patchCount} patches (${(result.bytes / 1024).toFixed(0)} KB)`,
            );
          } else if (result.notModified) {
            log.debug('sync', `${result.name}: not modified`);
          } else {
            log.warn('sync', `${result.name}: ${result.error ?? 'failed'}`);
          }
        }
        for (const warning of report.warnings) log.warn('registry', warning);

        log.info('sync', `Done in ${report.totalDurationMs} ms`, {
          bundles: report.snapshot.bundles.length,
          offline: report.offline,
        });
        if (report.offline) setError('All sources unreachable — showing cached data.');
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : String(syncError);
        setError(message);
        log.error('sync', 'Registry sync failed', syncError);
      } finally {
        setSyncing(false);
        setSyncProgress(null);
      }
    },
    [sources],
  );

  const addSource = useCallback(
    async (input: string): Promise<{ ok: boolean; message: string }> => {
      const resolved = resolveInput(input);
      if (resolved.error) {
        log.warn('sources', `Rejected source input "${input}": ${resolved.error}`);
        return { ok: false, message: resolved.error };
      }
      if (sources.some((s) => s.repo && resolved.repo && s.repo === resolved.repo)) {
        return { ok: false, message: `${resolved.repo} is already added.` };
      }

      // Probe the candidates before committing, so a typo produces an error
      // message instead of a permanently broken row in the source list.
      const probe = await probeSource(resolved.candidates);
      if (!probe.ok) {
        log.warn('sources', `Could not resolve ${resolved.displayName}`, probe.tried);
        return { ok: false, message: probe.message };
      }

      const source = makeCustomSource(resolved, probe.url);
      const next = [...sources, source];
      setSources(next);
      await kvSet(SOURCES_KEY, next);
      log.info('sources', `Added ${source.name}`, { url: probe.url, version: probe.version });

      // Pull it straight away so the user sees patches immediately.
      void sync({ force: true });
      return { ok: true, message: `${source.name} added.` };
    },
    [sources, sync],
  );

  const removeSource = useCallback(
    async (id: string) => {
      const next = sources.filter((s) => s.id !== id);
      setSources(next);
      await kvSet(SOURCES_KEY, next);
      log.info('sources', `Removed source ${id}`);
      void sync({ force: true });
    },
    [sources, sync],
  );

  const toggleSource = useCallback(
    async (id: string) => {
      const next = sources.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
      setSources(next);
      await kvSet(SOURCES_KEY, next);
      const changed = next.find((s) => s.id === id);
      log.info('sources', `${changed?.name} ${changed?.enabled ? 'enabled' : 'disabled'}`);
      void sync({ force: true });
    },
    [sources, sync],
  );

  const loadIcon = useCallback(
    async (packageName: string, size = ICON_SIZE): Promise<string | null> => {
      const key = `${packageName}@${size}`;
      const cached = iconCache.current.get(key);
      if (cached) return cached;

      const persisted = await readIcon(packageName, size);
      if (persisted) {
        iconCache.current.set(key, persisted);
        return persisted;
      }

      try {
        const { dataUrl } = await AppScanner.getIcon({ packageName, size });
        if (!dataUrl) return null;
        iconCache.current.set(key, dataUrl);
        await writeIcons([{ key, dataUrl, cachedAt: Date.now() }]);
        return dataUrl;
      } catch (iconError) {
        log.debug('icons', `No icon for ${packageName}`, iconError);
        return null;
      }
    },
    [],
  );

  const recheckUpdate = useCallback(() => {
    setUpdate({ kind: 'checking' });
    void checkForUpdate().then(setUpdate);
  }, []);

  const findMorphe = useCallback(async () => {
    try {
      const { installs } = await MorpheBridge.findMorpheInstalls();
      setMorpheInstalls(installs);
      log.info('morphe', `Found ${installs.length} Morphe install(s)`, installs);
    } catch (morpheError) {
      log.warn('morphe', 'Could not enumerate Morphe installs', morpheError);
    }
  }, []);

  const setFilters = useCallback((next: Partial<Filters>) => {
    setFiltersState((current) => {
      const merged = { ...current, ...next };
      void kvSet(FILTERS_KEY, merged);
      return merged;
    });
  }, []);

  /* --- First run ------------------------------------------------------ */
  useEffect(() => {
    if (!ready) return;
    // Kick off the scan and the first sync together; they do not depend on
    // each other and both are network/IO bound.
    void rescan();
    void sync();
    void findMorphe();
    // Checked here rather than in a screen, so switching tabs cannot fire a
    // second request against GitHub's 60-an-hour unauthenticated limit.
    recheckUpdate();
    // Intentionally once, on ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      logsOpen,
      setLogsOpen,
      syncing,
      scanning,
      syncProgress,
      snapshot,
      snapshotOrigin,
      sources,
      apps,
      matches,
      filteredMatches,
      index,
      filters,
      setFilters,
      morpheInstalls,
      scanMeta,
      lastScanAt,
      lastSyncAt,
      error,
      update,
      sync,
      recheckUpdate,
      rescan,
      addSource,
      removeSource,
      toggleSource,
      loadIcon,
      findMorphe,
    }),
    [
      ready,
      logsOpen,
      syncing,
      scanning,
      syncProgress,
      snapshot,
      snapshotOrigin,
      sources,
      apps,
      matches,
      filteredMatches,
      index,
      filters,
      setFilters,
      morpheInstalls,
      scanMeta,
      lastScanAt,
      lastSyncAt,
      error,
      update,
      sync,
      recheckUpdate,
      rescan,
      addSource,
      removeSource,
      toggleSource,
      loadIcon,
      findMorphe,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore must be used inside <StoreProvider>');
  return context;
}

/**
 * Try each candidate URL for a repo and report what came back.
 *
 * Doing this before the source is saved matters: the alternative is a source
 * row that looks fine and silently contributes nothing, which is the hardest
 * kind of bug for a user to diagnose.
 */
async function probeSource(
  candidates: string[],
): Promise<{ ok: true; url: string; version: string | null } | { ok: false; message: string; tried: string[] }> {
  for (const url of candidates) {
    try {
      const response = await httpGet({ url, timeoutMs: 12_000 });
      if (!response.ok) continue;

      const parsed = JSON.parse(response.body) as { version?: string; patches?: unknown[]; repo?: string };
      const hasPatches = Array.isArray(parsed.patches);
      // The GitHub releases API is the last resort and answers with an object
      // that has neither field; treat it as a manifest-only source.
      const isReleaseApi = url.includes('api.github.com');
      if (!hasPatches && !isReleaseApi && !parsed.repo) continue;

      return { ok: true, url, version: parsed.version ?? null };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    message: 'Nothing fetchable at that repository (no patches-list.json or patches-bundle.json).',
    tried: candidates,
  };
}
