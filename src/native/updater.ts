import { registerPlugin } from '@capacitor/core';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { log } from '@/diagnostics/logger';
import { compareVersions } from '@/core/version';

/**
 * In-app updates, driven by GitHub Releases.
 *
 * The repo is the distribution channel, so it is also the update channel: no
 * separate manifest to keep in step, and the release notes the user reads in the
 * app are the same ones on the release page.
 *
 * The trade-off worth naming is the permission. Handing an APK to the installer
 * on API 26+ needs `REQUEST_INSTALL_PACKAGES`, which is exactly the kind of
 * thing that makes an app look suspicious to Play Protect — and we removed
 * `REQUEST_DELETE_PACKAGES` earlier for that reason. A self-updating sideloaded
 * app cannot avoid it; the alternative is no in-app updates at all. It is
 * declared, and the user grants it explicitly.
 */

const REPO = 'd3ffen/patchit';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface AppUpdaterPlugin {
  download(options: {
    url: string;
    fileName: string;
    expectedBytes?: number;
  }): Promise<{ path: string; fileName: string; bytes: number }>;
  install(options: { path: string }): Promise<{ launched: boolean; reason?: string }>;
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  clearDownloads(): Promise<void>;
  addListener(
    eventName: 'downloadProgress',
    listener: (data: { percent: number; bytes: number; total: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

export const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater', {
  web: () => import('./updater.web').then((m) => new m.AppUpdaterWeb()),
});

export interface ReleaseInfo {
  /** Tag without the leading `v`, e.g. `1.0.2`. */
  version: string;
  tag: string;
  notes: string;
  publishedAt: string;
  /** Direct download URL for the APK asset. */
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current'; version: string }
  | { kind: 'available'; current: string; release: ReleaseInfo }
  | { kind: 'error'; message: string };

/** The version this build reports, from the native package manager. */
export async function currentVersion(): Promise<string> {
  try {
    const info = await CapacitorApp.getInfo();
    return info.version || '0.0.0';
  } catch (error) {
    log.warn('updater', 'Could not read the app version', error);
    return '0.0.0';
  }
}

/**
 * Compare against the newest published release.
 *
 * Tags are `v1.0.1` and the installed version is `1.0.1`, so the `v` has to come
 * off first. Leaving it on would make every comparison unequal — `parseVersion`
 * keeps a non-numeric prefix as a suffix, and a suffix sorts above none, so the
 * app would offer an "update" to the version it was already running.
 */
export async function checkForUpdate(): Promise<UpdateState> {
  const current = await currentVersion();

  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });

    if (response.status === 404) {
      // No releases published yet. Not an error worth showing anyone.
      return { kind: 'current', version: current };
    }
    if (!response.ok) {
      // Unauthenticated GitHub allows 60 requests an hour per address; a
      // rate-limited check is a hiccup, not a failure to report loudly.
      return { kind: 'error', message: `GitHub returned HTTP ${response.status}` };
    }

    const release = (await response.json()) as {
      tag_name?: string;
      body?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: { name: string; browser_download_url: string; size: number }[];
    };

    if (release.draft || release.prerelease) {
      return { kind: 'current', version: current };
    }

    const tag = release.tag_name ?? '';
    const version = tag.replace(/^v/i, '');
    if (!version) return { kind: 'current', version: current };

    const asset = (release.assets ?? []).find((a) => a.name.toLowerCase().endsWith('.apk'));
    if (!asset) {
      log.warn('updater', `Release ${tag} has no APK asset`);
      return { kind: 'current', version: current };
    }

    if (compareVersions(version, current) <= 0) {
      return { kind: 'current', version: current };
    }

    log.info('updater', `Update available: ${current} -> ${version}`, {
      asset: asset.name,
      bytes: asset.size,
    });

    return {
      kind: 'available',
      current,
      release: {
        version,
        tag,
        notes: (release.body ?? '').trim(),
        publishedAt: release.published_at ?? '',
        downloadUrl: asset.browser_download_url,
        fileName: asset.name,
        sizeBytes: asset.size,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('updater', 'Update check failed', error);
    return { kind: 'error', message };
  }
}

export interface DownloadHandle {
  /** Resolves when the download finishes; rejects on any failure. */
  done: Promise<{ path: string }>;
  /** Stop listening for progress. Does not abort the transfer. */
  stopListening: () => void;
}

/**
 * Download a release APK, reporting progress.
 *
 * Returns the promise rather than awaiting it so the caller can wire progress up
 * before the transfer starts — otherwise the first few percent are emitted
 * before anything is listening.
 */
export function downloadRelease(release: ReleaseInfo): DownloadHandle {
  let stop: (() => void) | undefined;

  if (Capacitor.isNativePlatform()) {
    void AppUpdater.addListener('downloadProgress', ({ percent }) => {
      progressListeners.forEach((listener) => listener(percent));
    }).then((handle) => {
      stop = () => void handle.remove();
    });
  }

  const done = AppUpdater.download({
    url: release.downloadUrl,
    fileName: release.fileName,
    expectedBytes: release.sizeBytes,
  }).then((result) => {
    log.info('updater', `Downloaded ${result.fileName}`, { bytes: result.bytes });
    return { path: result.path };
  });

  return { done, stopListening: () => stop?.() };
}

/**
 * Progress listeners live outside React so a download can outlive the sheet that
 * started it — switching tabs mid-download should not lose the bar.
 */
const progressListeners = new Set<(percent: number) => void>();

export function onDownloadProgress(listener: (percent: number) => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

export type InstallOutcome =
  | { kind: 'launched' }
  | { kind: 'needs-permission' }
  | { kind: 'failed'; message: string };

/** Hand a downloaded APK to the system installer. */
export async function installDownloaded(path: string): Promise<InstallOutcome> {
  try {
    const result = await AppUpdater.install({ path });
    if (result.launched) return { kind: 'launched' };
    if (result.reason === 'permission') return { kind: 'needs-permission' };
    return { kind: 'failed', message: 'The installer did not start.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('updater', 'Install hand-off failed', error);
    return { kind: 'failed', message };
  }
}

export async function canInstallPackages(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    return (await AppUpdater.canInstall()).allowed;
  } catch {
    return false;
  }
}

export async function openInstallPermissionSettings(): Promise<void> {
  try {
    await AppUpdater.openInstallSettings();
  } catch (error) {
    log.warn('updater', 'Could not open the install-permission screen', error);
  }
}

/** Human-readable size, for the release card. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}
