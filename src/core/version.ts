/**
 * Android version-string comparison.
 *
 * There is no such thing as "the" Android version format, and the Morphe
 * indexes prove it. Real values seen in the wild:
 *
 *   8.4.0                     19.16.39              2024.21.0
 *   13.0.0.2                  6.23.23+v15.5.0.70-armv7a
 *   13.0.1 build 25028        v10.36.5000           "7.16.51 (71651240)"
 *
 * Comparing these as strings is wrong in every direction. Comparing them as
 * strict semver is also wrong, because most of them are not semver. So we do
 * what Android's own `PackageManager` effectively does: pull out the numeric
 * runs and compare them component by component, then fall back to a
 * lexicographic tie-break so an ordering always exists.
 */

export interface ParsedVersion {
  /** Numeric components, padded to equal length at comparison time. */
  parts: number[];
  /** Trailing text after the numeric run, lowercased — pre-release tags etc. */
  suffix: string;
  /** True when at least one number was found. */
  numeric: boolean;
  raw: string;
}

const NUMERIC_RUN = /\d+/g;

export function parseVersion(input: string | null | undefined): ParsedVersion {
  const raw = (input ?? '').trim();
  if (!raw) return { parts: [], suffix: '', numeric: false, raw };

  // A versionCode in parentheses, as some bundles publish it, is metadata —
  // prefer the human version in front of it.
  const withoutParens = raw.replace(/\([^)]*\)/g, ' ');

  // Split on the structural separators only. Letters stay attached so that
  // "build 25028" keeps 25028 as a component and "rc1" contributes a 1.
  const parts: number[] = [];
  for (const match of withoutParens.match(NUMERIC_RUN) ?? []) {
    const value = Number.parseInt(match, 10);
    if (Number.isFinite(value)) parts.push(value);
  }

  const firstNumericAt = withoutParens.search(/\d/);
  const suffix = (firstNumericAt === -1 ? withoutParens : withoutParens.slice(0, firstNumericAt))
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim();

  return { parts, suffix, numeric: parts.length > 0, raw };
}

/**
 * Negative when `a < b`, positive when `a > b`, 0 when equal.
 *
 * Missing components count as zero, so 7.16 and 7.16.0 are equal — which is
 * the behaviour users expect and what Android's versionName comparison in
 * practice yields.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  if (!left.numeric && !right.numeric) {
    // Neither is numeric: the only honest ordering left is lexicographic.
    return left.raw.localeCompare(right.raw);
  }
  if (!left.numeric) return -1;
  if (!right.numeric) return 1;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.parts[i] ?? 0;
    const r = right.parts[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }

  if (left.suffix !== right.suffix) return left.suffix < right.suffix ? -1 : 1;
  return 0;
}

export function versionsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return compareVersions(a, b) === 0;
}

/**
 * Best-effort "is this the same release" check.
 *
 * Bundles are inconsistent about trailing components: the index may list
 * "7.16.51" while the device reports "7.16.51.2", or the other way round.
 * Treating a prefix match as equal, but only when the shorter side has at
 * least three components, avoids matching 7.1 against 7.16.
 */
export function versionsLooselyEqual(
  installed: string | null | undefined,
  supported: string | null | undefined,
): boolean {
  if (versionsEqual(installed, supported)) return true;
  const a = parseVersion(installed);
  const b = parseVersion(supported);
  if (!a.numeric || !b.numeric) return false;

  const shorter = a.parts.length <= b.parts.length ? a : b;
  const longer = shorter === a ? b : a;
  if (shorter.parts.length < 3) return false;

  for (let i = 0; i < shorter.parts.length; i += 1) {
    if (shorter.parts[i] !== longer.parts[i]) return false;
  }
  // Only the trailing components may differ, and only if the longer side adds
  // nothing beyond zeros or a build number.
  return true;
}

/** Highest version in a list, or null when the list is empty/non-numeric. */
export function maxVersion(versions: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (!candidate) continue;
    if (best === null || compareVersions(candidate, best) > 0) best = candidate;
  }
  return best;
}

export function minVersion(versions: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (!candidate) continue;
    if (best === null || compareVersions(candidate, best) < 0) best = candidate;
  }
  return best;
}

/** Sorted ascending, for the "supported versions" sheet. */
export function sortVersions(versions: string[]): string[] {
  return [...versions].sort(compareVersions);
}
