import type { InstalledApp } from '@/native/types';
import type {
  BundleEntry,
  NormalizedTarget,
  PatchEntry,
  RegistrySnapshot,
} from '@/registry/schema';
import { compareVersions, maxVersion, minVersion, sortVersions, versionsLooselyEqual } from './version';

/**
 * Deciding whether an installed app can actually be patched.
 *
 * This is the piece the whole app exists for, and it is subtler than "does the
 * version string appear in the list":
 *
 *  - A patch may declare the package but list *no* versions, meaning it is
 *    version-agnostic. That is a green-ish light, not a red one, but it is not
 *    the same as "tested against your build", so it gets its own verdict.
 *  - versionCodes beat version names. When a target publishes an arm64-v8a
 *    versionCode and the device reports that code, that is proof. Names like
 *    "7.16.51" are hand-typed and drift.
 *  - An app can be covered by several bundles, each supporting a different
 *    version. The app-level verdict is therefore a *summary*; the detail screen
 *    shows the per-bundle truth.
 *  - Experimental targets are supported, but the user deserves to know before
 *    they hand their account to a patch.
 */

export type Verdict =
  | 'supported'
  | 'experimental'
  | 'unlisted'
  | 'too-new'
  | 'too-old'
  | 'no-patches';

export type SignatureVerdict = 'verified' | 'unknown' | 'mismatch' | 'no-certificate';

export interface PatchMatch {
  patch: PatchEntry;
  bundle: BundleEntry;
  verdict: Verdict;
  /** The target that decided the verdict, when one was involved. */
  target: NormalizedTarget | null;
  /** True when a published versionCode matched the installed one. */
  matchedByVersionCode: boolean;
  /** All versions this patch declares for the installed package. */
  supportedVersions: string[];
}

export interface BundleMatch {
  bundle: BundleEntry;
  verdict: Verdict;
  /** Patches in this bundle that apply to the installed version right now. */
  usablePatches: PatchMatch[];
  /** Patches for this package at *some* version, usable or not. */
  patchesForPackage: PatchMatch[];
  supportedVersions: string[];
  supportedVersionCodes: number[];
  experimental: boolean;
  /** Closest version the user could move to. Null when the patch is agnostic. */
  suggestedVersion: string | null;
}

export interface AppMatch {
  app: InstalledApp;
  verdict: Verdict;
  bundles: BundleMatch[];
  /**
   * Patches from the registry that apply to any app, regardless of this one's
   * verdict. Never counted in `usablePatchCount` — see `RegistryIndex.universal`.
   */
  universalPatches: PatchMatch[];
  /** Patches that can be applied to the installed build. */
  usablePatchCount: number;
  /** Patches for this app at any version. */
  totalPatchCount: number;
  supportedVersions: string[];
  /** Version nearest the installed one that is known-good. */
  recommendedVersion: string | null;
  signature: SignatureVerdict;
  /** Human-readable reasons, shown verbatim in the detail sheet. */
  notes: string[];
}

/** Worst-to-best ordering, used to summarise several patches into one verdict. */
const SEVERITY: Record<Verdict, number> = {
  supported: 0,
  experimental: 1,
  unlisted: 2,
  'too-old': 3,
  'too-new': 4,
  'no-patches': 5,
};

/** Pick the *least* severe verdict: one good match is enough to make a green light. */
function bestVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'no-patches';
  return verdicts.reduce((best, v) => (SEVERITY[v] < SEVERITY[best] ? v : best), 'no-patches');
}

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

export interface RegistryIndex {
  /** packageName -> every patch that names it, with its bundle. */
  byPackage: Map<string, { patch: PatchEntry; bundle: BundleEntry }[]>;
  /** packageName -> version-agnostic advertising, for the "not installed" browser. */
  allPackages: Set<string>;
  /**
   * Patches that declare no compatible packages at all, and therefore apply to
   * any app — "Change package name", "Unlock premium", custom trust anchors.
   *
   * These are kept apart from `byPackage` on purpose. Folding them in would make
   * every installed app look patchable, which would be technically true and
   * completely useless: the "only apps with patches" filter would stop filtering.
   * They are surfaced separately instead, so nothing is hidden but nothing is
   * overstated either.
   */
  universal: { patch: PatchEntry; bundle: BundleEntry }[];
  snapshot: RegistrySnapshot;
}

export function buildIndex(snapshot: RegistrySnapshot): RegistryIndex {
  const byPackage = new Map<string, { patch: PatchEntry; bundle: BundleEntry }[]>();
  const allPackages = new Set<string>();
  const universal: { patch: PatchEntry; bundle: BundleEntry }[] = [];

  for (const bundle of snapshot.bundles) {
    for (const patch of bundle.patches) {
      if (patch.compatibilities.length === 0) {
        // `universal` is set by the parser when a patch declares no packages;
        // a patch that does name packages but lost them in parsing is a bug,
        // not a universal patch, so require the flag too.
        if (patch.universal) universal.push({ patch, bundle });
        continue;
      }

      for (const compat of patch.compatibilities) {
        allPackages.add(compat.packageName);
        const list = byPackage.get(compat.packageName);
        const entry = { patch, bundle };
        if (list) list.push(entry);
        else byPackage.set(compat.packageName, [entry]);
      }
    }
  }

  return { byPackage, allPackages, universal, snapshot };
}

/* ------------------------------------------------------------------ *
 * Per-patch evaluation
 * ------------------------------------------------------------------ */

function evaluatePatch(
  patch: PatchEntry,
  bundle: BundleEntry,
  app: InstalledApp,
): PatchMatch | null {
  const compat = patch.compatibilities.find((c) => c.packageName === app.packageName);
  if (!compat) {
    // Universal patches declare no packages. They are real, and Morphe will
    // offer them, but they are not a compatibility signal for this app.
    if (patch.universal) {
      return {
        patch,
        bundle,
        verdict: 'unlisted',
        target: null,
        matchedByVersionCode: false,
        supportedVersions: [],
      };
    }
    return null;
  }

  const targets: NormalizedTarget[] = compat.targets;
  const supportedVersions = targets
    .map((t) => t.version)
    .filter((v): v is string => typeof v === 'string');

  // 1. A published versionCode is the strongest possible evidence.
  const codeMatch = targets.find(
    (t) => t.versionCodes && Object.values(t.versionCodes).includes(app.versionCode),
  );
  if (codeMatch) {
    return {
      patch,
      bundle,
      verdict: codeMatch.isExperimental ? 'experimental' : 'supported',
      target: codeMatch,
      matchedByVersionCode: true,
      supportedVersions,
    };
  }

  // 2. No targets at all: the patch works on any version, untested.
  if (targets.length === 0) {
    return {
      patch,
      bundle,
      verdict: 'unlisted',
      target: null,
      matchedByVersionCode: false,
      supportedVersions,
    };
  }

  // 3. Version-name equality, exact then loose.
  const exact = targets.find((t) => t.version && compareVersions(t.version, app.versionName) === 0);
  if (exact) {
    return {
      patch,
      bundle,
      verdict: exact.isExperimental ? 'experimental' : 'supported',
      target: exact,
      matchedByVersionCode: false,
      supportedVersions,
    };
  }

  const loose = targets.find((t) => versionsLooselyEqual(app.versionName, t.version));
  if (loose) {
    return {
      patch,
      bundle,
      verdict: loose.isExperimental ? 'experimental' : 'supported',
      target: loose,
      matchedByVersionCode: false,
      supportedVersions,
    };
  }

  // 4. Outside the declared range. Which side?
  const highest = maxVersion(supportedVersions);
  const lowest = minVersion(supportedVersions);

  if (highest && compareVersions(app.versionName, highest) > 0) {
    return {
      patch,
      bundle,
      verdict: 'too-new',
      target: targets.find((t) => t.version === highest) ?? null,
      matchedByVersionCode: false,
      supportedVersions,
    };
  }

  if (lowest && compareVersions(app.versionName, lowest) < 0) {
    return {
      patch,
      bundle,
      verdict: 'too-old',
      target: targets.find((t) => t.version === lowest) ?? null,
      matchedByVersionCode: false,
      supportedVersions,
    };
  }

  // 5. A version is declared, it just is not comparable to ours (e.g. the
  //    index lists "13.0.1 build 25028" and the device says "13.0.1").
  return {
    patch,
    bundle,
    verdict: 'unlisted',
    target: targets[0] ?? null,
    matchedByVersionCode: false,
    supportedVersions,
  };
}

/* ------------------------------------------------------------------ *
 * Signature
 * ------------------------------------------------------------------ */

function evaluateSignature(
  entries: { patch: PatchEntry; bundle: BundleEntry }[],
  app: InstalledApp,
): SignatureVerdict {
  if (!app.signatureSha256) return 'no-certificate';

  const vouched = new Set<string>();
  let sawAny = false;
  for (const { patch } of entries) {
    for (const compat of patch.compatibilities) {
      if (compat.packageName !== app.packageName) continue;
      if (compat.signatures && compat.signatures.length > 0) {
        sawAny = true;
        for (const s of compat.signatures) vouched.add(s);
      }
    }
  }

  if (!sawAny) return 'unknown';
  return vouched.has(app.signatureSha256.toUpperCase()) ? 'verified' : 'mismatch';
}

/* ------------------------------------------------------------------ *
 * App-level evaluation
 * ------------------------------------------------------------------ */

/** A patch counts as usable when it will not refuse to run on this version. */
const USABLE: Verdict[] = ['supported', 'experimental', 'unlisted'];

/**
 * Universal patches, shaped like ordinary matches.
 *
 * Their verdict is `unlisted` in every case: declaring no packages also means
 * declaring no versions, so there is genuinely nothing to verify against. They
 * need no per-app evaluation at all, which is why this is not a call to
 * `evaluatePatch`.
 */
function collectUniversalPatches(index: RegistryIndex): PatchMatch[] {
  return index.universal.map(({ patch, bundle }) => ({
    patch,
    bundle,
    verdict: 'unlisted' as Verdict,
    target: null,
    matchedByVersionCode: false,
    supportedVersions: [],
  }));
}

export function evaluateApp(app: InstalledApp, index: RegistryIndex): AppMatch {
  const entries = index.byPackage.get(app.packageName) ?? [];
  const universalPatches = collectUniversalPatches(index);
  const notes: string[] = [];

  if (entries.length === 0) {
    return {
      app,
      verdict: 'no-patches',
      bundles: [],
      universalPatches,
      usablePatchCount: 0,
      totalPatchCount: 0,
      supportedVersions: [],
      recommendedVersion: null,
      signature: 'unknown',
      notes: [],
    };
  }

  const matches = entries
    .map(({ patch, bundle }) => evaluatePatch(patch, bundle, app))
    .filter((m): m is PatchMatch => m !== null);

  // Group by bundle, preserving the index order so the UI is stable.
  const byBundle = new Map<string, PatchMatch[]>();
  for (const match of matches) {
    const list = byBundle.get(match.bundle.id);
    if (list) list.push(match);
    else byBundle.set(match.bundle.id, [match]);
  }

  const bundleMatches: BundleMatch[] = [];
  for (const [bundleId, patchMatches] of byBundle) {
    const bundle = patchMatches[0].bundle;
    const usable = patchMatches.filter((m) => USABLE.includes(m.verdict));

    const supportedVersions = sortVersions(
      Array.from(new Set(patchMatches.flatMap((m) => m.supportedVersions))),
    );
    const supportedVersionCodes = Array.from(
      new Set(
        patchMatches.flatMap((m) =>
          m.target?.versionCodes ? Object.values(m.target.versionCodes) : [],
        ),
      ),
    ).sort((a, b) => a - b);

    const verdict = bestVerdict(patchMatches.map((m) => m.verdict));

    bundleMatches.push({
      bundle,
      verdict,
      usablePatches: usable,
      patchesForPackage: patchMatches,
      supportedVersions,
      supportedVersionCodes,
      experimental: patchMatches.some((m) => m.verdict === 'experimental'),
      suggestedVersion: pickRecommended(app.versionName, supportedVersions),
    });
    void bundleId;
  }

  // Sort bundles so the most useful ones (something usable) come first.
  bundleMatches.sort((a, b) => {
    const aUsable = a.usablePatches.length > 0 ? 0 : 1;
    const bUsable = b.usablePatches.length > 0 ? 0 : 1;
    if (aUsable !== bUsable) return aUsable - bUsable;
    return b.usablePatches.length - a.usablePatches.length;
  });

  const usablePatchCount = matches.filter((m) => USABLE.includes(m.verdict)).length;
  const supportedVersions = sortVersions(
    Array.from(new Set(matches.flatMap((m) => m.supportedVersions))),
  );
  const verdict = bestVerdict(matches.map((m) => m.verdict));
  const signature = evaluateSignature(entries, app);

  if (verdict === 'too-new') {
    notes.push(
      `Installed ${app.versionName} is newer than the newest supported build${supportedVersions.length ? ` (${maxVersion(supportedVersions)})` : ''}. Patches may fail to apply or crash.`,
    );
  } else if (verdict === 'too-old') {
    notes.push(
      `Installed ${app.versionName} is older than the oldest supported build${supportedVersions.length ? ` (${minVersion(supportedVersions)})` : ''}. Update the app, or expect patch failures.`,
    );
  } else if (verdict === 'unlisted') {
    notes.push('The sources cover this app but declare no versions, so any build is a guess.');
  }

  if (verdict === 'supported' && usablePatchCount < matches.length) {
    notes.push(
      `${matches.length - usablePatchCount} of ${matches.length} patches target other versions and will be skipped.`,
    );
  }
  if (bundleMatches.some((b) => b.experimental)) {
    notes.push('At least one matching target is marked experimental.');
  }
  if (signature === 'mismatch') {
    notes.push(
      'The installed build is signed with a certificate the sources do not vouch for. Morphe will ask before patching it.',
    );
  } else if (signature === 'no-certificate') {
    notes.push('Could not read the APK signing certificate; signature cannot be verified.');
  }
  if (app.hasSplits) {
    notes.push(
      `Split install (${app.splitSourceDirs.length + 1} APKs). Morphe needs every split, and the patched result must be installed as a fresh bundle.`,
    );
  }

  return {
    app,
    verdict,
    bundles: bundleMatches,
    universalPatches,
    usablePatchCount,
    totalPatchCount: matches.length,
    supportedVersions,
    recommendedVersion: pickRecommended(app.versionName, supportedVersions),
    signature,
    notes,
  };
}

/**
 * The version we would send someone to. Prefers the newest supported version
 * that is not newer than what they already have — downgrading is easier to
 * live with than losing app data to an upgrade.
 */
export function pickRecommended(
  installed: string,
  supported: string[],
): string | null {
  if (supported.length === 0) return null;

  const notNewer = supported.filter((v) => compareVersions(v, installed) <= 0);
  if (notNewer.length > 0) return maxVersion(notNewer);

  // Everything supported is newer than the install, so the closest older
  // relative is the smallest supported version.
  return minVersion(supported);
}

export function evaluateAll(apps: InstalledApp[], index: RegistryIndex): AppMatch[] {
  return apps.map((app) => evaluateApp(app, index));
}
