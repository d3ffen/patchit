import type { PatchSource, SourceKind } from './schema';

/**
 * Where patch data comes from, and how to turn a user-typed string into
 * something fetchable.
 *
 * Two first-party indexes ship by default:
 *
 *   official   MorpheApp/morphe-patches patches-list.json  — 166 patches,
 *              but only for YouTube, YouTube Music and Reddit. Authoritative
 *              and machine-generated.
 *   community  morphe-patches.software/data/bundles.json   — 222 third-party
 *              bundles covering 1000+ packages. A crawl, so it is messy, but it
 *              is the only place most apps appear.
 *
 * Everything else is user-added. Both matter: without the official list you miss
 * versionCodes and signing certificates, and without the community list you miss
 * almost every app.
 */

export const OFFICIAL_INDEX_URL =
  'https://raw.githubusercontent.com/MorpheApp/morphe-patches/main/patches-list.json';

export const COMMUNITY_INDEX_URL = 'https://morphe-patches.software/data/bundles.json';

export const OFFICIAL_REPO = 'MorpheApp/morphe-patches';

/** Morphe Manager's own landing page for a repository deep link. */
export function addSourceDeepLink(repo: string): string {
  const [host, path] = repo.includes('gitlab.com')
    ? ['gitlab', repo.replace(/^https?:\/\/gitlab\.com\//, '')]
    : ['github', repo.replace(/^https?:\/\/(www\.)?github\.com\//, '')];
  return `https://morphe.software/add-source?${host}=${encodeURIComponent(path)}`;
}

export function defaultSources(now = Date.now()): PatchSource[] {
  return [
    {
      id: 'official',
      kind: 'official',
      name: 'Morphe (official)',
      repo: OFFICIAL_REPO,
      indexUrl: OFFICIAL_INDEX_URL,
      enabled: true,
      addedAt: now,
      lastSyncAt: null,
      lastSyncError: null,
      version: null,
      bundleCount: 0,
      patchCount: 0,
      uid: 1,
    },
    {
      id: 'community',
      kind: 'community',
      name: 'Community index',
      repo: null,
      indexUrl: COMMUNITY_INDEX_URL,
      enabled: true,
      addedAt: now,
      lastSyncAt: null,
      lastSyncError: null,
      version: null,
      bundleCount: 0,
      patchCount: 0,
      uid: 2,
    },
  ];
}

export interface ResolvedInput {
  kind: SourceKind;
  /** "owner/repo" for a repository, or the normalised index URL. */
  repo: string | null;
  /** Candidate URLs to try, in order. First success wins. */
  candidates: string[];
  displayName: string;
  error?: string;
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Accepts what Morphe Manager accepts, because a user who has a working source
 * in one app should not have to translate it for the other:
 *
 *   github.com/owner/repo            gitlab.com/owner/repo
 *   owner/repo                       https://example.com/patches-bundle.json
 */
export function resolveInput(input: string): ResolvedInput {
  const raw = input.trim();
  if (!raw) {
    return { kind: 'custom', repo: null, candidates: [], displayName: '', error: 'Enter a repository or bundle URL.' };
  }

  // A direct link to an index or bundle manifest.
  if (/^https?:\/\//i.test(raw)) {
    if (/\.json(\?.*)?$/i.test(raw)) {
      return {
        kind: 'custom',
        repo: null,
        candidates: [raw],
        displayName: raw.split('/').slice(-1)[0] ?? raw,
      };
    }

    const github = raw.match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
    if (github) return fromRepo(github[1], 'github');
    const gitlab = raw.match(/gitlab\.com\/([\w.-]+\/[\w.-]+)/i);
    if (gitlab) return fromRepo(gitlab[1], 'gitlab');

    return {
      kind: 'custom',
      repo: null,
      candidates: [],
      displayName: raw,
      error: 'Only GitHub/GitLab repositories or a direct .json URL can be added.',
    };
  }

  if (REPO_PATTERN.test(raw)) return fromRepo(raw, 'github');

  return {
    kind: 'custom',
    repo: null,
    candidates: [],
    displayName: raw,
    error: 'Not a repository. Use "owner/repo", a GitHub/GitLab URL, or a .json link.',
  };
}

function fromRepo(repo: string, host: 'github' | 'gitlab'): ResolvedInput {
  const clean = repo.replace(/\.git$/, '');
  if (host === 'gitlab') {
    return {
      kind: 'custom',
      repo: clean,
      candidates: [
        `https://gitlab.com/${clean}/-/raw/main/patches-list.json`,
        `https://gitlab.com/${clean}/-/raw/main/patches-bundle.json`,
        `https://gitlab.com/${clean}/-/raw/master/patches-list.json`,
      ],
      displayName: clean,
    };
  }

  // Morphe's own patch generator writes patches-list.json at the repo root;
  // patches-bundle.json is the release manifest. Most repos have one, some have
  // both, and the branch is a coin flip, so try the four realistic combinations.
  return {
    kind: 'custom',
    repo: clean,
    candidates: [
      `https://raw.githubusercontent.com/${clean}/main/patches-list.json`,
      `https://raw.githubusercontent.com/${clean}/main/patches-bundle.json`,
      `https://raw.githubusercontent.com/${clean}/master/patches-list.json`,
      `https://raw.githubusercontent.com/${clean}/master/patches-bundle.json`,
      `https://api.github.com/repos/${clean}/releases/latest`,
    ],
    displayName: clean,
  };
}

export function newSourceId(repo: string | null, url: string): string {
  const basis = repo ?? url;
  return `custom:${basis.toLowerCase()}`;
}

export function makeCustomSource(resolved: ResolvedInput, url: string, now = Date.now()): PatchSource {
  return {
    id: newSourceId(resolved.repo, url),
    kind: resolved.kind,
    name: resolved.displayName,
    repo: resolved.repo,
    indexUrl: url,
    enabled: true,
    addedAt: now,
    lastSyncAt: null,
    lastSyncError: null,
    version: null,
    bundleCount: 0,
    patchCount: 0,
    uid: 0,
  };
}
