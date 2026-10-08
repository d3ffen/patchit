/**
 * Builds the offline seed registry: `public/bundled-registry.json`.
 *
 * Why this exists
 * ---------------
 * A fresh install with no network — or with `morphe-patches.software` having
 * moved — currently knows about exactly nothing until a sync succeeds. The
 * community index is an undocumented endpoint that the site serves to its own
 * frontend, so "it will always be there" is not an assumption worth betting the
 * first-run experience on.
 *
 * This script captures the current state of both live indexes, runs it through
 * the *same* converter the app uses at runtime, and ships the result as a static
 * asset. First launch reads it, so the list is populated with 900+ apps
 * immediately, and the network sync then refines it.
 *
 * Why it is safe to ship stale data
 * ---------------------------------
 * The seed is a *fallback*, not a source. Its bundles carry the real `sourceId`
 * values (`official`, `community`), so `syncRegistry` already treats it
 * correctly: a successful fetch replaces it, and a failed fetch keeps it for
 * that source only. Staleness is therefore visible rather than silent — the
 * version strings it carries are simply older.
 *
 * Run with: npm run build:seed
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { convert } from '@/registry/sync';
import { defaultSources } from '@/registry/sources';
import type { BundleEntry, PatchEntry, RegistrySnapshot } from '@/registry/schema';

/**
 * `.seed`, not `.json.gz`, and that is load-bearing.
 *
 * AAPT2 treats an asset whose name ends in `.gz` as something Android's
 * AssetManager would gunzip on demand: it **decompresses it at package time and
 * strips the extension**. Ship `bundled-registry.json.gz` and the APK ends up
 * containing `bundled-registry.json` at the full 4.8 MB — a fetch for the
 * original name 404s, and the seed silently never loads.
 *
 * An opaque extension sidesteps the special case entirely. The content is still
 * gzip; only the name stopped advertising it.
 */
const OUT = resolve(process.cwd(), 'public/bundled-registry.seed');

/**
 * Descriptions are the bulk of the payload and the least load-bearing part of
 * it. The detail sheet shows two or three lines of each; anything past that is
 * bytes nobody reads. Truncating keeps the asset small enough to ship without
 * measuring the download in megabytes.
 */
const PATCH_DESCRIPTION_LIMIT = 240;
const BUNDLE_DESCRIPTION_LIMIT = 200;

function clip(text: string | null, limit: number): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Patch options are dropped entirely.
 *
 * The app only ever renders *how many* options a patch exposes ("2 options"),
 * because the actual values are Morphe Manager's business, not the scanner's.
 * Two bundles in the index carry verbose per-option prose — it is a meaningful
 * share of the file for information nothing displays.
 */
function trimPatch(patch: PatchEntry): PatchEntry {
  return {
    ...patch,
    description: clip(patch.description, PATCH_DESCRIPTION_LIMIT),
    options: [],
  };
}

function trimBundle(bundle: BundleEntry): BundleEntry {
  return {
    ...bundle,
    repoDescription: clip(bundle.repoDescription, BUNDLE_DESCRIPTION_LIMIT),
    patches: bundle.patches.map(trimPatch),
  };
}

async function fetchJson(url: string): Promise<{ body: unknown; bytes: number }> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const text = await response.text();
  return { body: JSON.parse(text), bytes: text.length };
}

async function main(): Promise<void> {
  const sources = defaultSources();
  const warnings: string[] = [];
  const bundles: BundleEntry[] = [];

  for (const source of sources.filter((s) => s.kind === 'official' || s.kind === 'community')) {
    const { body, bytes } = await fetchJson(source.indexUrl);
    const converted = convert(source, body, warnings);
    console.log(
      `${source.name.padEnd(20)} ${(bytes / 1024).toFixed(0).padStart(5)} KB in · ` +
        `${converted.bundles.length} bundles, ` +
        `${converted.bundles.reduce((n, b) => n + b.patches.length, 0)} patches`,
    );
    bundles.push(...converted.bundles.map(trimBundle));
  }

  const snapshot: RegistrySnapshot = {
    officialVersion: null,
    communityGeneratedAt: null,
    bundles,
    // Sources are not stored in the seed: the app always builds those from
    // `defaultSources()` so a seed can never resurrect a source the user removed.
    sources: [],
    fetchedAt: Date.now(),
    warnings: [],
  };

  mkdirSync(dirname(OUT), { recursive: true });

  /**
   * Stored gzipped, and that is not a micro-optimisation: the normalised
   * snapshot is 4.7 MB of JSON, because the compatibility targets are repeated
   * per patch. Gzipped with the redundancy squeezed out it is ~460 KB, which is
   * an acceptable thing to carry in an APK next to a 402 KB JS bundle. The app
   * inflates it with the platform's `DecompressionStream` — see
   * `src/registry/seed.ts`.
   */
  const json = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const gz = gzipSync(json, { level: 9 });
  writeFileSync(OUT, gz);

  const packages = new Set(bundles.flatMap((b) => b.targetApps));
  console.log(
    `\nwrote public/bundled-registry.seed\n` +
      `  ${(json.length / 1024 / 1024).toFixed(2)} MB raw -> ${(gz.length / 1024).toFixed(0)} KB gzipped\n` +
      `  ${bundles.length} bundles · ${packages.size} packages · ` +
      `${bundles.reduce((n, b) => n + b.patches.length, 0)} patches`,
  );

  if (warnings.length > 0) {
    console.log(`\n${warnings.length} parser warnings:`);
    for (const warning of warnings.slice(0, 10)) console.log(`  - ${warning}`);
  }
}

await main();
