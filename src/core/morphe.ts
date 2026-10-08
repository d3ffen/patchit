import { MorpheBridge } from '@/native/plugins';
import type { MorpheActionResult } from '@/native/types';
import { log } from '@/diagnostics/logger';
import { addSourceDeepLink } from '@/registry/sources';
import type { AppMatch, BundleMatch } from './compatibility';

/**
 * The hand-off to Morphe Manager, which is now exactly one thing: giving Morphe
 * the patch *sources* that cover an app.
 *
 * Morphe also accepts a batch-patch intent, and this app used to send it. It no
 * longer does, on purpose. `BATCH_PATCH` arms a patch-and-install queue, and a
 * scanner that does that from one tap is the wrong shape: the useful thing a
 * scanner can do is make sure the sources are present, after which Morphe's own
 * UI drives the patch with the user seeing exactly what will be applied. The
 * scanner decides *whether* something is patchable; Morphe decides *how*.
 *
 * Adding a source is also the safer of the two by a wide margin. Morphe
 * validates the repository and asks the user to confirm before it is added, and
 * adding a source installs and patches nothing on its own.
 */

export interface HandoffOutcome {
  ok: boolean;
  /** Shown to the user verbatim. */
  message: string;
}

/**
 * Repositories worth adding to Morphe for this app.
 *
 * Sources are included even when none of their patches match the installed
 * build. That reversal was deliberate: the previous version filtered on
 * `usablePatches.length > 0`, which meant an app sitting at a version no source
 * supports showed *no* way to act on it — precisely the case where a user wants
 * to add the sources, downgrade, and keep going. The scanner's job is to tell
 * them the version does not match and still give them the button.
 *
 * The official patch set is still filtered out: Morphe ships
 * `MorpheApp/morphe-patches` pre-installed, so offering to add it is noise — the
 * user taps, Morphe says "already added", and the app looks broken.
 *
 * Sources that *do* match are listed first, since those are the ones that will
 * work without changing anything.
 */
export function addableRepos(match: AppMatch): string[] {
  const matching: string[] = [];
  const other: string[] = [];

  for (const bundleMatch of match.bundles) {
    if (isBuiltIn(bundleMatch)) continue;

    const repo = normaliseRepo(bundleMatch.bundle.repo);
    if (!repo) continue;

    const list = bundleMatch.usablePatches.length > 0 ? matching : other;
    if (!list.includes(repo) && !matching.includes(repo)) list.push(repo);
  }

  return [...matching, ...other.filter((repo) => !matching.includes(repo))];
}

/** True when Morphe already has this source and adding it would be a no-op. */
export function isBuiltIn(bundleMatch: BundleMatch): boolean {
  return bundleMatch.bundle.sourceId === 'official';
}

/**
 * `owner/repo` from whatever the index carried.
 *
 * Most entries are already bare, but a few publish a full URL, and one or two
 * carry a `.git` suffix. Morphe's deep link only accepts `owner/repo`.
 */
function normaliseRepo(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?(github|gitlab)\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

  // Must look like owner/repo and nothing longer — a nested path is not a
  // repository Morphe can add.
  const parts = cleaned.split('/');
  if (parts.length !== 2 || parts.some((p) => p.length === 0)) return null;
  return cleaned;
}

/**
 * Deep-link one repository into Morphe's "add patch source" flow.
 *
 * Morphe asks for confirmation before adding, so a `true` result means "Morphe
 * is now asking", not "the source is installed".
 */
export async function addRepoToMorphe(repo: string): Promise<HandoffOutcome> {
  const url = addSourceDeepLink(repo);
  log.info('morphe', `Opening add-source link for ${repo}`, url);

  let result: MorpheActionResult;
  try {
    result = await MorpheBridge.openSourceLink({ url });
  } catch (error) {
    log.error('morphe', 'add-source link threw', error);
    return { ok: false, message: 'Android refused the request. See the log for details.' };
  }

  if (result.delivered) {
    log.info('morphe', `Handed ${repo} to ${result.resolvedActivity}`);
    return { ok: true, message: `Morphe is asking to add ${repo}.` };
  }

  switch (result.reason) {
    case 'not-installed':
      log.warn('morphe', 'Morphe Manager is not installed');
      return {
        ok: false,
        message: 'Morphe Manager is not installed, so there is nowhere to add this source.',
      };
    case 'no-activity':
      log.warn('morphe', 'Nothing handles morphe.software links');
      return { ok: false, message: 'No app on this device can open Morphe source links.' };
    case 'security-exception':
      return { ok: false, message: result.message ?? 'Android blocked the link.' };
    default:
      return { ok: false, message: result.message ?? 'Could not open the link.' };
  }
}

/**
 * Add several repositories, one at a time.
 *
 * Sequential rather than parallel on purpose: each one launches an activity and
 * Morphe shows a confirmation per link, so firing them together would stack
 * dialogs the user cannot reason about. We also stop at the first hard failure
 * (Morphe missing) instead of repeating the same error N times.
 */
export async function addReposToMorphe(repos: string[]): Promise<HandoffOutcome> {
  if (repos.length === 0) {
    return { ok: false, message: 'No addable sources for this app.' };
  }

  const added: string[] = [];
  for (const repo of repos) {
    const outcome = await addRepoToMorphe(repo);
    if (!outcome.ok) {
      if (added.length === 0) return outcome;
      return {
        ok: true,
        message: `Added ${added.length} of ${repos.length} sources. ${outcome.message}`,
      };
    }
    added.push(repo);
  }

  return {
    ok: true,
    message:
      added.length === 1
        ? `Morphe is asking to add ${added[0]}.`
        : `Morphe is asking to add ${added.length} sources.`,
  };
}
