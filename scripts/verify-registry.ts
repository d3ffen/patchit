/**
 * End-to-end verification of the registry pipeline.
 *
 * This exists because the two indexes are *live third-party documents*, and the
 * parser's whole job is to survive them. A unit test against a fixture would
 * prove the parser handles the shape I imagined; this proves it handles the
 * shape that is actually being served right now — including the 1129 list-shaped
 * entries, the flat TV-app maps and whatever a 223rd bundle introduces.
 *
 * Run with: npm run verify:registry
 *
 * It checks, in order:
 *   1. the official patches-list.json parses, and how much it covers;
 *   2. the community bundles.json parses without throwing on any of its shapes;
 *   3. both convert into BundleEntry[] and merge into a snapshot;
 *   4. the compatibility engine produces a sane verdict for a set of known apps.
 */

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { parseCommunityIndex, normalizeCompatibilityPool, parseOfficialList } from '@/registry/normalize';
import { convert } from '@/registry/sync';
import { buildIndex, evaluateAll } from '@/core/compatibility';
import { compareVersions, versionsLooselyEqual } from '@/core/version';
import type { PatchSource, RegistrySnapshot } from '@/registry/schema';
import { resolve } from 'node:path';
import type { InstalledApp } from '@/native/types';

const OFFICIAL_URL = 'https://raw.githubusercontent.com/MorpheApp/morphe-patches/main/patches-list.json';
const COMMUNITY_URL = 'https://morphe-patches.software/data/bundles.json';

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

async function fetchJson(url: string): Promise<{ body: string; ms: number }> {
  const started = Date.now();
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return { body: await response.text(), ms: Date.now() - started };
}

function source(id: string, kind: PatchSource['kind'], url: string, repo: string | null): PatchSource {
  return {
    id,
    kind,
    name: id,
    repo,
    indexUrl: url,
    enabled: true,
    addedAt: Date.now(),
    lastSyncAt: null,
    lastSyncError: null,
    version: null,
    bundleCount: 0,
    patchCount: 0,
    uid: 0,
  };
}

function app(packageName: string, label: string, versionName: string, versionCode: number): InstalledApp {
  return {
    packageName,
    label,
    versionName,
    versionCode,
    isSystem: false,
    isUpdatedSystemApp: false,
    isEnabled: true,
    isSuspended: false,
    sourceDir: `/data/app/${packageName}/base.apk`,
    splitSourceDirs: [],
    hasSplits: false,
    uid: 10_000,
    targetSdk: 34,
    minSdk: 21,
    signatureSha256: null,
    firstInstallTime: Date.now(),
    lastUpdateTime: Date.now(),
    apkSizeBytes: 1_000_000,
  };
}

/* ------------------------------------------------------------------ *
 * Version comparison, the foundation everything else rests on
 * ------------------------------------------------------------------ */

section('Version comparison');
check('19.16.39 > 19.16.38', compareVersions('19.16.39', '19.16.38') > 0);
check('7.16.51 == 7.16.51.0 (missing components are zero)', compareVersions('7.16.51', '7.16.51.0') === 0);
check('13.0.1 build 25028 > 13.0.1', compareVersions('13.0.1 build 25028', '13.0.1') > 0);
check('2024.21.0 > 2024.9.0 (numeric, not lexicographic)', compareVersions('2024.21.0', '2024.9.0') > 0);
check(
  '6.23.23+v15.5.0.70-armv7a compares numerically',
  compareVersions('6.23.23+v15.5.0.70-armv7a', '6.23.23') >= 0,
);
check('loose match accepts a trailing build component', versionsLooselyEqual('7.16.51.2', '7.16.51'));
check('loose match rejects a different minor', !versionsLooselyEqual('7.17.0', '7.16.51'));

/* ------------------------------------------------------------------ *
 * Official index
 * ------------------------------------------------------------------ */

section('Official patches-list.json');
const officialRaw = await fetchJson(OFFICIAL_URL);
console.log(`  fetched ${(officialRaw.body.length / 1024).toFixed(0)} KB in ${officialRaw.ms} ms`);

const officialParsed = parseOfficialList(JSON.parse(officialRaw.body));
check('parses without throwing', true);
check('declares a version', Boolean(officialParsed.value.version), officialParsed.value.version);
check('has a plausible patch count', officialParsed.value.patches.length > 50, `${officialParsed.value.patches.length} patches`);
check('every patch has a name', officialParsed.value.patches.every((p) => Boolean(p.name)));

const officialWarnings = officialParsed.warnings;
check('parses cleanly', officialWarnings.length === 0, officialWarnings.slice(0, 3).join(' | '));

const officialBundle = convert(
  source('official', 'official', OFFICIAL_URL, 'MorpheApp/morphe-patches'),
  JSON.parse(officialRaw.body),
  [],
);
check('converts to exactly one bundle', officialBundle.bundles.length === 1);
const officialTargets = new Set(officialBundle.bundles[0].targetApps);
check(
  'covers YouTube, YouTube Music and Reddit',
  ['com.google.android.youtube', 'com.google.android.apps.youtube.music', 'com.reddit.frontpage']
    .every((p) => officialTargets.has(p)),
  `${officialTargets.size} packages`,
);
const youtubePatch = officialBundle.bundles[0].patches.find((p) =>
  p.targetPackages.includes('com.google.android.youtube'),
);
check('a YouTube patch carries version targets', Boolean(youtubePatch?.compatibilities[0]?.targets.length), `${youtubePatch?.compatibilities[0]?.targets.length ?? 0} targets`);

/* ------------------------------------------------------------------ *
 * Community index
 * ------------------------------------------------------------------ */

section('Community bundles.json');
const communityRaw = await fetchJson(COMMUNITY_URL);
console.log(`  fetched ${(communityRaw.body.length / 1024 / 1024).toFixed(2)} MB in ${communityRaw.ms} ms`);

const communityJson = JSON.parse(communityRaw.body) as { compatibilities: unknown[] };
const pool = normalizeCompatibilityPool(communityJson.compatibilities);
check('compatibility pool normalises every entry', pool.value.length === communityJson.compatibilities.length);

const shaped = pool.value.filter((group) => group.length > 0).length;
check('most pool entries yield at least one package', shaped > communityJson.compatibilities.length * 0.9,
  `${shaped}/${communityJson.compatibilities.length} non-empty`);

const communityParsed = parseCommunityIndex(communityJson, (key) => pool.value[key] ?? []);
check('parses without throwing', true);
check('has a plausible bundle count', communityParsed.value.bundles.length > 100, `${communityParsed.value.bundles.length} bundles`);

const communityBundle = convert(
  source('community', 'community', COMMUNITY_URL, null),
  communityJson,
  [],
);
const totalCommunityPatches = communityBundle.bundles.reduce((n, b) => n + b.patches.length, 0);
const communityPackages = new Set(communityBundle.bundles.flatMap((b) => b.targetApps));
check('converts every bundle', communityBundle.bundles.length === communityParsed.value.bundles.length);
check('extracts patches', totalCommunityPatches > 200, `${totalCommunityPatches} patches`);
check('covers far more apps than the official list', communityPackages.size > 200, `${communityPackages.size} distinct packages`);
check(
  'patches carry bundle provenance',
  communityBundle.bundles.every((b) => b.patches.every((p) => p.bundleId === b.id && p.sourceId === 'community')),
);

// A bundle with patches but no target apps is legitimate only when every patch
// is universal (declares no compatible packages). Anything else means the
// compatibility pool lookup silently failed — which is the difference between
// "no patches for this app" and a bug nobody can see.
const suspicious = communityBundle.bundles.filter(
  (b) => b.targetApps.length === 0 && b.patches.some((p) => !p.universal),
);
check(
  'no bundle silently lost its target apps',
  suspicious.length === 0,
  suspicious.map((b) => b.repo).join(', '),
);

const universalBundles = communityBundle.bundles.filter((b) =>
  b.patches.every((p) => p.universal),
);
const universalPatches = communityBundle.bundles.flatMap((b) =>
  b.patches.filter((p) => p.universal),
);
check(
  'universal patch bundles are recognised as universal, not as empty',
  universalBundles.length > 0,
  `${universalBundles.length} bundles, ${universalPatches.length} patches`,
);

/* ------------------------------------------------------------------ *
 * Merge and evaluate
 * ------------------------------------------------------------------ */

section('Snapshot + compatibility engine');
const snapshot: RegistrySnapshot = {
  officialVersion: officialParsed.value.version,
  communityGeneratedAt: null,
  bundles: [...officialBundle.bundles, ...communityBundle.bundles],
  sources: [],
  fetchedAt: Date.now(),
  warnings: [],
};
const index = buildIndex(snapshot);
console.log(`  index: ${index.byPackage.size} packages, ${snapshot.bundles.length} bundles`);

// A version that exists in the official list, and one past the end of it.
const youtubeTarget = youtubePatch?.compatibilities[0]?.targets.find((t) => t.version)?.version ?? '19.16.39';

const apps: InstalledApp[] = [
  app('com.google.android.youtube', 'YouTube', youtubeTarget, 1),
  app('com.google.android.youtube', 'YouTube (future build)', '99.99.99', 999_999_999),
  app('com.google.android.apps.youtube.music', 'YouTube Music', '0.0.1', 1),
  app('com.reddit.frontpage', 'Reddit', youtubeTarget, 1),
  app('de.pixelhouse', 'Chefkoch', '8.4.0', 1),
  app('com.example.definitely.not.in.registry', 'Nothing', '1.0', 1),
];

const matches = evaluateAll(apps, index);
for (const [i, match] of matches.entries()) {
  const label = apps[i].label.padEnd(24);
  console.log(
    `  ${label} ${match.verdict.padEnd(11)} ${match.usablePatchCount}/${match.totalPatchCount} patches, ${match.bundles.length} sources`,
  );
}

const byLabel = new Map(matches.map((m, i) => [apps[i].label, m]));
check(
  'an exact official version is supported',
  byLabel.get('YouTube')?.verdict === 'supported' || byLabel.get('YouTube')?.verdict === 'experimental',
  byLabel.get('YouTube')?.verdict,
);
check('a future build is flagged too-new', byLabel.get('YouTube (future build)')?.verdict === 'too-new');
check('an ancient build is flagged too-old', byLabel.get('YouTube Music')?.verdict === 'too-old');
check('a community-only app is found', (byLabel.get('Chefkoch')?.totalPatchCount ?? 0) > 0);
check('an unknown app reports no-patches', byLabel.get('Nothing')?.verdict === 'no-patches');
check(
  'universal patches are offered without inflating the verdict',
  (byLabel.get('Nothing')?.universalPatches.length ?? 0) > 0 &&
    byLabel.get('Nothing')?.verdict === 'no-patches' &&
    byLabel.get('Nothing')?.usablePatchCount === 0,
  `${byLabel.get('Nothing')?.universalPatches.length ?? 0} universal patches`,
);
check(
  'a too-new app still lists the patches it cannot use',
  (byLabel.get('YouTube (future build)')?.totalPatchCount ?? 0) > 0,
);
check(
  'every match has a usable-version set or a clean reason',
  matches.every((m) => m.verdict !== 'supported' || m.usablePatchCount > 0),
);

/* ------------------------------------------------------------------ *
 * Compatibility shapes
 * ------------------------------------------------------------------ *
 *
 * A patch list can declare compatible packages in four different shapes, and
 * this parser used to accept one of them — coercing the rest to `null`, which
 * means "universal". A user reported PatchIt giving false results on Facebook;
 * the cause was a source whose 86 app-specific patches were all relabelled as
 * applying to any app. These fixtures are that report, reduced to a table.
 */

section('Compatibility shapes');

const SHAPE_CASES: {
  label: string;
  patch: Record<string, unknown>;
  expectUniversal: boolean;
  expectPackages: string[];
  expectVersions: string[];
}[] = [
  {
    label: 'Morphe schema — array of objects',
    patch: {
      name: 'Hide ads',
      compatiblePackages: [
        { packageName: 'com.example.app', name: 'Example', targets: [{ version: '1.2.3', versionCodes: { 'arm64-v8a': 123 } }] },
      ],
    },
    expectUniversal: false,
    expectPackages: ['com.example.app'],
    expectVersions: ['1.2.3'],
  },
  {
    label: 'flat map — { pkg: [versions] }',
    patch: { name: 'Hide ads', compatiblePackages: { 'com.example.app': ['1.2.3', '1.2.4'] } },
    expectUniversal: false,
    expectPackages: ['com.example.app'],
    expectVersions: ['1.2.3', '1.2.4'],
  },
  {
    label: 'array of package names — no versions',
    patch: { name: 'Hide ads', compatiblePackages: ['com.example.app'] },
    expectUniversal: false,
    expectPackages: ['com.example.app'],
    expectVersions: [],
  },
  {
    label: 'absent — genuinely universal',
    patch: { name: 'Change package name' },
    expectUniversal: true,
    expectPackages: [],
    expectVersions: [],
  },
  {
    label: 'explicit null — universal',
    patch: { name: 'Change package name', compatiblePackages: null },
    expectUniversal: true,
    expectPackages: [],
    expectVersions: [],
  },
];

for (const testCase of SHAPE_CASES) {
  const warnings: string[] = [];
  const list = parseOfficialList({ version: '1', patches: [testCase.patch] });
  const bundle = convert(
    source(`probe:${testCase.label}`, 'custom', 'https://example.invalid', 'owner/repo'),
    { version: '1', patches: [testCase.patch] },
    warnings,
  ).bundles[0];

  const patch = bundle.patches[0];
  const packages = patch.compatibilities.map((c) => c.packageName);
  const versions = patch.compatibilities.flatMap((c) => c.targets.map((t) => t.version));

  const ok =
    patch.universal === testCase.expectUniversal &&
    JSON.stringify(packages) === JSON.stringify(testCase.expectPackages) &&
    JSON.stringify(versions) === JSON.stringify(testCase.expectVersions);

  check(
    testCase.label,
    ok,
    ok
      ? `universal=${patch.universal} packages=${packages.length} versions=${versions.length}`
      : `got universal=${patch.universal} packages=${JSON.stringify(packages)} versions=${JSON.stringify(versions)}`,
  );
  // A parse failure on a known shape should never spam the log.
  if (list.warnings.length > 0 && !testCase.label.startsWith('array of package names')) {
    check(`${testCase.label} — parses without warnings`, false, list.warnings.join(' | '));
  }
}

/*
 * The field some generators write alongside `compatiblePackages`. It carries the
 * same list plus signing certificates, so it should win.
 */
{
  const raw = {
    version: '1',
    patches: [
      {
        name: 'Hide ads',
        compatiblePackages: { 'com.example.app': ['9.9.9'] },
        compatibility: [
          {
            packageName: 'com.example.app',
            name: 'Example',
            targets: [{ version: '1.2.3' }],
            signatures: ['ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789'],
          },
        ],
      },
    ],
  };
  const bundle = convert(
    source('probe:rich', 'custom', 'https://example.invalid', 'owner/repo'),
    raw,
    [],
  ).bundles[0];
  const versions = bundle.patches[0].compatibilities.flatMap((c) => c.targets.map((t) => t.version));
  check(
    '`compatibility` is preferred over `compatiblePackages`',
    versions.length === 1 && versions[0] === '1.2.3',
    `versions=${JSON.stringify(versions)}`,
  );
  check(
    'signing certificates survive parsing',
    bundle.patches[0].compatibilities[0].signatures?.length === 1,
  );
}

/*
 * The regression itself. An unreadable declaration must NOT become universal —
 * that is the whole bug — and it must say so out loud.
 */
{
  const warnings: string[] = [];
  const bundle = convert(
    source('probe:unknown', 'custom', 'https://example.invalid', 'owner/repo'),
    { version: '1', patches: [{ name: 'Weird', compatiblePackages: 42 }] },
    warnings,
  ).bundles[0];
  check(
    'an unreadable shape is not relabelled as universal',
    bundle.patches[0].universal === false,
    `universal=${bundle.patches[0].universal}`,
  );
  check(
    'and it is reported rather than swallowed',
    warnings.length > 0 && warnings[0].includes('cannot read'),
    warnings[0] ?? 'no warning',
  );
}

/* ------------------------------------------------------------------ *
 * The bundled offline seed
 * ------------------------------------------------------------------ */

section('Bundled seed (cold start with no network)');

const seedPath = resolve(process.cwd(), 'public/bundled-registry.seed');
let seed: RegistrySnapshot | null = null;

try {
  const raw = readFileSync(seedPath);
  const json = gunzipSync(raw).toString('utf8');
  seed = JSON.parse(json) as RegistrySnapshot;
  console.log(`  ${(raw.length / 1024).toFixed(0)} KB gzipped -> ${(json.length / 1024 / 1024).toFixed(2)} MB raw`);
} catch (error) {
  check(`bundled seed readable at ${seedPath}`, false, String(error));
}

if (seed) {
  const seedPackages = new Set(seed.bundles.flatMap((b) => b.targetApps));
  check('seed has a useful number of bundles', seed.bundles.length > 200, `${seed.bundles.length} bundles`);
  check('seed covers hundreds of packages', seedPackages.size > 900, `${seedPackages.size} packages`);

  /*
   * This is the property that makes the seed work as a *fallback* rather than a
   * fourth source. `syncRegistry` keeps a previous snapshot's bundles per
   * source when a fetch fails, so the seed must present itself as the real
   * sources. If it used its own id like "seed", a failed sync would drop it and
   * the user would lose their app list.
   */
  const seedSourceIds = new Set(seed.bundles.map((b) => b.sourceId));
  check(
    'seed bundles carry the real source ids',
    [...seedSourceIds].every((id) => id === 'official' || id === 'community'),
    [...seedSourceIds].join(', '),
  );

  // The whole point: real verdicts with no network at all.
  const seedIndex = buildIndex(seed);
  const coldMatches = evaluateAll(
    [app('de.pixelhouse', 'Chefkoch', '8.4.0', 1), app('com.example.nope', 'Nope', '1.0', 1)],
    seedIndex,
  );
  console.log(
    `  cold start: ${seedIndex.byPackage.size} packages indexed · ` +
      `Chefkoch ${coldMatches[0].verdict} (${coldMatches[0].usablePatchCount} patches)`,
  );
  check('a cold start finds a patchable app from the seed alone', coldMatches[0].usablePatchCount > 0);
  check('a cold start still reports unknown apps honestly', coldMatches[1].verdict === 'no-patches');
}

/* ------------------------------------------------------------------ */

section('Result');
if (failures === 0) {
  console.log('  All checks passed.');
} else {
  console.log(`  ${failures} check(s) failed.`);
  process.exitCode = 1;
}
