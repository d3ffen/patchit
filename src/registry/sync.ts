import type {
  BundleEntry,
  CommunityBundle,
  NormalizedCompatibility,
  PatchEntry,
  PatchSource,
  RegistrySnapshot,
} from './schema';
import {
  normalizeCompatibilityPool,
  parseCommunityIndex,
  parseOfficialCompatibility,
  parseOfficialList,
  parseRepoBundleManifest,
  type CompatibilityGroups,
} from './normalize';
import { getEtag, getLastModified, httpGet, mapWithConcurrency } from './http';
import { readHttpCache, writeHttpCache, writeSnapshot } from './cache';
import { OFFICIAL_REPO } from './sources';

/**
 * The sync pipeline: fetch -> parse -> normalise -> snapshot.
 *
 * Design rules that the code below follows deliberately:
 *
 *  - One failing source never fails the sync. A dead third-party repo, a 404, a
 *    bundle with malformed JSON: each is recorded against its own source and the
 *    rest of the registry still lands. This is the difference between a tool you
 *    can rely on and one that breaks because someone else's repo went private.
 *  - Sources are fetched concurrently but bounded, because a user with thirty
 *    custom repos should not open thirty sockets.
 *  - A 304 keeps the previous parse for that source and only refreshes its
 *    timestamp.
 */

export interface SyncProgress {
  phase: 'start' | 'fetching' | 'parsing' | 'done' | 'error';
  sourceId?: string;
  sourceName?: string;
  completed: number;
  total: number;
  message?: string;
}

export interface SyncReport {
  snapshot: RegistrySnapshot;
  perSource: {
    sourceId: string;
    name: string;
    ok: boolean;
    notModified: boolean;
    bytes: number;
    durationMs: number;
    bundleCount: number;
    patchCount: number;
    error: string | null;
  }[];
  warnings: string[];
  totalDurationMs: number;
  /** True when every source failed and the snapshot is the previous one. */
  offline: boolean;
}

export interface SyncOptions {
  sources: PatchSource[];
  /** Previous snapshot, used to keep data for sources that answer 304 or fail. */
  previous: RegistrySnapshot | null;
  onProgress?: (progress: SyncProgress) => void;
}

export async function syncRegistry(options: SyncOptions): Promise<SyncReport> {
  const started = performance.now();
  const { sources, previous, onProgress } = options;
  const active = sources.filter((s) => s.enabled);

  onProgress?.({ phase: 'start', completed: 0, total: active.length });

  let completed = 0;
  const warnings: string[] = [];

  const results = await mapWithConcurrency(active, 4, async (source) => {
    const result = await syncOne(source, previous, warnings);
    completed += 1;
    onProgress?.({
      phase: 'fetching',
      sourceId: source.id,
      sourceName: source.name,
      completed,
      total: active.length,
      message: result.ok
        ? result.notModified
          ? `${source.name}: up to date`
          : `${source.name}: ${result.bundleCount} bundles`
        : `${source.name}: ${result.error}`,
    });
    return result;
  });

  // Sources that are disabled, or that we never got to, keep whatever the
  // previous snapshot had for them.
  const keptBundles = previous
    ? previous.bundles.filter((b) => !active.some((s) => s.id === b.sourceId))
    : [];

  const bundles = [...keptBundles, ...results.flatMap((r) => r.bundles)];

  const snapshot: RegistrySnapshot = {
    officialVersion:
      results.find((r) => r.source.id === 'official')?.version ??
      previous?.officialVersion ??
      null,
    communityGeneratedAt: previous?.communityGeneratedAt ?? null,
    bundles,
    sources: results.map((r) => r.source),
    fetchedAt: Date.now(),
    warnings,
  };

  const offline = results.length > 0 && results.every((r) => !r.ok && !r.notModified);

  onProgress?.({ phase: 'done', completed: active.length, total: active.length });
  await writeSnapshot(snapshot);

  return {
    snapshot,
    perSource: results.map((r) => ({
      sourceId: r.source.id,
      name: r.source.name,
      ok: r.ok,
      notModified: r.notModified,
      bytes: r.bytes,
      durationMs: r.durationMs,
      bundleCount: r.bundleCount,
      patchCount: r.patchCount,
      error: r.error,
    })),
    warnings,
    totalDurationMs: Math.round(performance.now() - started),
    offline,
  };
}

interface OneResult {
  source: PatchSource;
  bundles: BundleEntry[];
  ok: boolean;
  notModified: boolean;
  bytes: number;
  durationMs: number;
  bundleCount: number;
  patchCount: number;
  error: string | null;
  version: string | null;
}

async function syncOne(
  source: PatchSource,
  previous: RegistrySnapshot | null,
  warnings: string[],
): Promise<OneResult> {
  const started = performance.now();
  const cached = await readHttpCache(source.indexUrl);

  const base: OneResult = {
    source,
    bundles: [],
    ok: false,
    notModified: false,
    bytes: 0,
    durationMs: 0,
    bundleCount: 0,
    patchCount: 0,
    error: null,
    version: null,
  };

  const previousBundles = previous?.bundles.filter((b) => b.sourceId === source.id) ?? [];

  let response;
  try {
    response = await httpGet({
      url: source.indexUrl,
      etag: cached?.etag ?? null,
      lastModified: cached?.lastModified ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${source.name}: ${message}`);
    // A failed fetch is survivable: show the last known good data for this source.
    return {
      ...base,
      bundles: previousBundles,
      notModified: previousBundles.length > 0,
      error: message,
      durationMs: Math.round(performance.now() - started),
      bundleCount: previousBundles.length,
      patchCount: previousBundles.reduce((n, b) => n + b.patches.length, 0),
    };
  }

  if (response.notModified && previousBundles.length > 0) {
    return {
      ...base,
      ok: true,
      notModified: true,
      bundles: previousBundles,
      durationMs: Math.round(performance.now() - started),
      bundleCount: previousBundles.length,
      patchCount: previousBundles.reduce((n, b) => n + b.patches.length, 0),
    };
  }

  if (!response.ok) {
    // Cloudflare and friends answer 5xx with an HTML error page; saying so is
    // far more useful than "Unexpected token < in JSON".
    const message = `HTTP ${response.status}${response.status === 403 ? ' (rate limited or blocked)' : ''}`;
    warnings.push(`${source.name}: ${message}`);
    return {
      ...base,
      bundles: previousBundles,
      error: message,
      durationMs: response.durationMs,
      bytes: response.body.length,
    };
  }

  const bytes = response.body.length;
  await writeHttpCache({
    url: source.indexUrl,
    etag: getEtag(response),
    lastModified: getLastModified(response),
    fetchedAt: Date.now(),
    status: response.status,
    body: response.body,
  });

  let raw: unknown;
  try {
    raw = JSON.parse(response.body);
  } catch (error) {
    const message = `malformed JSON at ${source.indexUrl}`;
    warnings.push(`${source.name}: ${message}`);
    return {
      ...base,
      bundles: previousBundles,
      error: message,
      bytes,
      durationMs: response.durationMs,
    };
  }

  try {
    const parsed = convert(source, raw, warnings);
    return {
      source: { ...source, lastSyncAt: Date.now(), lastSyncError: null, version: parsed.version },
      bundles: parsed.bundles,
      ok: true,
      notModified: false,
      bytes,
      durationMs: Math.round(performance.now() - started),
      bundleCount: parsed.bundles.length,
      patchCount: parsed.bundles.reduce((n, b) => n + b.patches.length, 0),
      error: null,
      version: parsed.version,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${source.name}: ${message}`);
    return {
      ...base,
      bundles: previousBundles,
      error: message,
      bytes,
      durationMs: response.durationMs,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Conversion
 * ------------------------------------------------------------------ */

interface Converted {
  bundles: BundleEntry[];
  version: string | null;
}

/**
 * Exported for the verification script. It is a pure function of (source, raw),
 * which is exactly what makes the registry pipeline testable without a WebView,
 * an IndexedDB or a network.
 */
export function convert(source: PatchSource, raw: unknown, warnings: string[]): Converted {
  if (source.kind === 'official') return convertOfficial(source, raw, warnings);
  if (source.kind === 'community') return convertCommunity(source, raw, warnings);
  return convertCustom(source, raw, warnings);
}

function convertOfficial(
  source: PatchSource,
  raw: unknown,
  warnings: string[],
): Converted {
  const { value, warnings: parseWarnings } = parseOfficialList(raw);
  warnings.push(...parseWarnings.map((w) => `${source.name}: ${w}`));

  const patches: PatchEntry[] = value.patches.map((p, index) => {
    // Shared with the community pool parser so the two paths cannot drift.
    const compatibilities: NormalizedCompatibility[] = (p.compatiblePackages ?? [])
      .map(parseOfficialCompatibility)
      .filter((c): c is NormalizedCompatibility => c !== null);

    return {
      id: `official:${index}:${p.name ?? 'unnamed'}`,
      sourceId: source.id,
      bundleId: 'official',
      name: p.name ?? 'Unnamed patch',
      description: p.description ?? null,
      default: p.default,
      category: p.category ?? null,
      dependencies: p.dependencies,
      options: p.options.map((o) => ({
        key: o.key,
        title: o.title,
        description: o.description,
        required: o.required,
        type: o.type,
        defaultValue: o.default,
        values: o.values,
      })),
      universal: p.compatiblePackages === null,
      compatibilities,
      targetPackages: Array.from(new Set(compatibilities.map((c) => c.packageName))),
    };
  });

  const bundle = makeBundle({
    id: 'official',
    sourceId: source.id,
    repo: OFFICIAL_REPO,
    name: 'Morphe (official)',
    author: 'Morphe',
    avatarUrl: null,
    deepLink: null,
    changelogUrl: null,
    repoDescription:
      'The official patch set. Covers YouTube, YouTube Music and Reddit, with version codes and signing certificates.',
    stars: 0,
    updatedAt: null,
    patches,
  });

  return { bundles: [bundle], version: value.version };
}

function convertCommunity(
  source: PatchSource,
  raw: unknown,
  warnings: string[],
): Converted {
  const pool = normalizeCompatibilityPool(
    Array.isArray((raw as { compatibilities?: unknown[] })?.compatibilities)
      ? ((raw as { compatibilities: unknown[] }).compatibilities ?? [])
      : [],
  );
  warnings.push(...pool.warnings.map((w) => `${source.name}: ${w}`));

  const { value, warnings: parseWarnings } = parseCommunityIndex(raw, (key) => pool.value[key] ?? []);
  warnings.push(...parseWarnings.map((w) => `${source.name}: ${w}`));

  // The pool is index-addressed, so keep it as groups AND build a
  // packageName -> group lookup for bundles that omit compatiblePackagesKey.
  const bundles = value.bundles.map((b, index) =>
    communityBundleToEntry(source, b, pool.value, index),
  );

  return { bundles, version: null };
}

function communityBundleToEntry(
  source: PatchSource,
  b: CommunityBundle,
  groups: CompatibilityGroups,
  index: number,
): BundleEntry {
  const byPackage = new Map<string, NormalizedCompatibility>();
  for (const group of groups) {
    for (const compat of group) {
      if (!byPackage.has(compat.packageName)) byPackage.set(compat.packageName, compat);
    }
  }

  const patches: PatchEntry[] = b.patches.map((p, patchIndex) => {
    let compatibilities: NormalizedCompatibility[] = [];
    if (typeof p.compatiblePackagesKey === 'number') {
      compatibilities = groups[p.compatiblePackagesKey] ?? [];
    }
    // Some bundles ship no key at all. Falling back to the bundle's own
    // targetApps recovers the version data instead of dropping it.
    if (compatibilities.length === 0) {
      compatibilities = b.targetApps
        .map((pkg) => byPackage.get(pkg))
        .filter((c): c is NormalizedCompatibility => c !== undefined);
    }

    return {
      id: `${source.id}:${b.repo}:${patchIndex}:${p.name}`,
      sourceId: source.id,
      bundleId: `community:${b.repo}`,
      name: p.name,
      description: p.description,
      default: p.default,
      category: null,
      dependencies: [],
      options: [],
      universal: compatibilities.length === 0,
      compatibilities,
      targetPackages: Array.from(new Set(compatibilities.map((c) => c.packageName))),
    };
  });

  return makeBundle({
    id: `community:${b.repo || index}`,
    sourceId: source.id,
    repo: b.repo,
    name: b.name || b.repo,
    author: b.author,
    avatarUrl: b.avatarUrl ?? null,
    deepLink: b.deepLink ?? null,
    changelogUrl: b.changelogUrl ?? null,
    repoDescription: b.repoDescription ?? null,
    stars: b.stars,
    updatedAt: b.updatedAt ?? null,
    patches,
  });
}

/**
 * A custom source is either a patch list (rich, like the official file) or a
 * release manifest (metadata only — enough to show the source and link out,
 * not enough to enumerate patches). Both are accepted; the UI says which.
 */
function convertCustom(source: PatchSource, raw: unknown, warnings: string[]): Converted {
  const looksLikePatchList =
    typeof raw === 'object' && raw !== null && Array.isArray((raw as { patches?: unknown }).patches);

  if (looksLikePatchList) {
    const converted = convertOfficial(
      { ...source, id: source.id, repo: source.repo ?? OFFICIAL_REPO, name: source.name },
      raw,
      warnings,
    );
    return {
      version: converted.version,
      bundles: converted.bundles.map((b) => ({
        ...b,
        id: source.id,
        sourceId: source.id,
        repo: source.repo ?? b.repo,
        name: source.name,
      })),
    };
  }

  const manifest = parseRepoBundleManifest(raw);
  const bundle = makeBundle({
    id: source.id,
    sourceId: source.id,
    repo: source.repo ?? source.name,
    name: source.name,
    author: source.name,
    avatarUrl: null,
    deepLink: null,
    changelogUrl: null,
    repoDescription: manifest.description,
    stars: 0,
    updatedAt: manifest.createdAt ? Date.parse(manifest.createdAt) || null : null,
    patches: [],
  });

  warnings.push(
    `${source.name}: this repo publishes only a release manifest (v${manifest.version ?? '?'}), so its patches cannot be listed without downloading the .mpp bundle.`,
  );

  return { bundles: [bundle], version: manifest.version };
}

function makeBundle(input: {
  id: string;
  sourceId: string;
  repo: string;
  name: string;
  author: string;
  avatarUrl: string | null;
  deepLink: string | null;
  changelogUrl: string | null;
  repoDescription: string | null;
  stars: number;
  updatedAt: number | null;
  patches: PatchEntry[];
}): BundleEntry {
  const versionsByPackage: Record<string, string[]> = {};
  const experimentalByPackage: Record<string, boolean> = {};
  const targetApps = new Set<string>();

  for (const patch of input.patches) {
    for (const compat of patch.compatibilities) {
      targetApps.add(compat.packageName);
      const versions = versionsByPackage[compat.packageName] ??= [];
      const targets = compat.targets ?? [];

      for (const target of targets) {
        if (target.version && !versions.includes(target.version)) versions.push(target.version);
      }

      if (targets.length > 0) {
        const allExperimental = targets.every((t) => t.isExperimental);
        if (allExperimental) experimentalByPackage[compat.packageName] = true;
        else if (!(compat.packageName in experimentalByPackage)) {
          experimentalByPackage[compat.packageName] = false;
        }
      }
    }
  }

  return {
    id: input.id,
    sourceId: input.sourceId,
    repo: input.repo,
    name: input.name,
    author: input.author,
    avatarUrl: input.avatarUrl,
    deepLink: input.deepLink,
    changelogUrl: input.changelogUrl,
    repoDescription: input.repoDescription,
    stars: input.stars,
    updatedAt: input.updatedAt,
    patchCount: input.patches.length,
    targetApps: Array.from(targetApps).sort(),
    patches: input.patches,
    versionsByPackage,
    experimentalByPackage,
  };
}
