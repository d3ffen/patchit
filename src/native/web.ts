/**
 * Browser implementations of the three native plugins.
 *
 * Everything here is fake, and deliberately so: it lets the whole UI, the
 * registry pipeline and the compatibility engine be developed and tested with
 * plain `npm run dev`, at a fraction of a second per iteration instead of the
 * minutes a Gradle build + adb install costs.
 *
 * The fixture versions are real ones from the Morphe patches list, so
 * "supported / too new / too old" states all appear in the browser.
 */

import type {
  AppScannerPlugin,
  MorpheBridgePlugin,
  SystemThemePlugin,
} from './plugins';
import type {
  IconResult,
  ScanOptions,
  ScanResult,
  SystemPalette,
  InstalledApp,
} from './types';
import type { MorpheActionResult } from './types';

const DAY = 86_400_000;

function app(partial: Partial<InstalledApp> & Pick<InstalledApp, 'packageName' | 'label' | 'versionName' | 'versionCode'>): InstalledApp {
  return {
    isSystem: false,
    isUpdatedSystemApp: false,
    isEnabled: true,
    isSuspended: false,
    sourceDir: `/data/app/~~mock/${partial.packageName}-mock/base.apk`,
    splitSourceDirs: [],
    hasSplits: false,
    uid: 10_000 + Math.floor(Math.random() * 9000),
    targetSdk: 34,
    minSdk: 21,
    signatureSha256: null,
    firstInstallTime: Date.now() - 30 * DAY,
    lastUpdateTime: Date.now() - 3 * DAY,
    apkSizeBytes: 20 * 1024 * 1024,
    ...partial,
  };
}

const MOCK_APPS: InstalledApp[] = [
  app({
    packageName: 'com.google.android.youtube',
    label: 'YouTube',
    versionName: '19.16.39',
    versionCode: 1547904384,
    hasSplits: true,
    splitSourceDirs: [
      '/data/app/~~mock/com.google.android.youtube-mock/split_config.arm64_v8a.apk',
      '/data/app/~~mock/com.google.android.youtube-mock/split_config.xxhdpi.apk',
    ],
    targetSdk: 34,
    apkSizeBytes: 148 * 1024 * 1024,
  }),
  app({
    packageName: 'com.google.android.apps.youtube.music',
    label: 'YouTube Music',
    versionName: '7.16.51',
    versionCode: 71651240,
    hasSplits: true,
    splitSourceDirs: ['/data/app/~~mock/com.google.android.apps.youtube.music-mock/split_config.arm64_v8a.apk'],
    apkSizeBytes: 62 * 1024 * 1024,
  }),
  app({
    packageName: 'com.reddit.frontpage',
    label: 'Reddit',
    versionName: '2024.21.0',
    versionCode: 1_234_567,
    hasSplits: true,
    splitSourceDirs: ['/data/app/~~mock/com.reddit.frontpage-mock/split_config.arm64_v8a.apk'],
    apkSizeBytes: 84 * 1024 * 1024,
  }),
  // Deliberately one version past what the index supports, to exercise the
  // "too new" branch of the compatibility engine.
  app({
    packageName: 'com.spotify.music',
    label: 'Spotify',
    versionName: '9.9.99',
    versionCode: 9_999_999,
    apkSizeBytes: 71 * 1024 * 1024,
  }),
  app({
    packageName: 'com.instagram.android',
    label: 'Instagram',
    versionName: '340.0.0.0.1',
    versionCode: 340_000_001,
    apkSizeBytes: 190 * 1024 * 1024,
  }),
  app({
    packageName: 'org.telegram.messenger',
    label: 'Telegram',
    versionName: '10.14.2',
    versionCode: 4_600_000,
    apkSizeBytes: 66 * 1024 * 1024,
  }),
  app({
    packageName: 'com.android.chrome',
    label: 'Chrome',
    versionName: '126.0.6478.71',
    versionCode: 6_478_071,
    isSystem: true,
    isUpdatedSystemApp: true,
    apkSizeBytes: 240 * 1024 * 1024,
  }),
  app({
    packageName: 'com.android.settings',
    label: 'Settings',
    versionName: '14',
    versionCode: 34,
    isSystem: true,
    isUpdatedSystemApp: false,
    apkSizeBytes: 12 * 1024 * 1024,
  }),
];

/** Deterministic 2-char monogram, so the browser fallback icons look intentional. */
function monogram(label: string): string {
  const clean = label.replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const words = clean.split(/\s+/);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
}

function hashCode(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class AppScannerWeb implements AppScannerPlugin {
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const started = performance.now();
    const skipped: { packageName: string; reason: string }[] = [];
    const apps = MOCK_APPS.filter((a) => {
      if (a.isSystem && !a.isUpdatedSystemApp && !options.includeSystem) {
        skipped.push({ packageName: a.packageName, reason: 'system app (filtered)' });
        return false;
      }
      if (a.hasSplits && options.includeSplits === false) {
        skipped.push({ packageName: a.packageName, reason: 'split install (filtered)' });
        return false;
      }
      return true;
    });
    return {
      apps,
      durationMs: Math.round(performance.now() - started),
      skipped,
      deviceSdk: 34,
      fullVisibility: true,
    };
  }

  async getIcon({ packageName, size = 128 }: { packageName: string; size?: number }): Promise<IconResult> {
    const found = MOCK_APPS.find((a) => a.packageName === packageName);
    const label = found?.label ?? packageName;
    const hue = hashCode(packageName) % 360;
    // Roughly M3 tonal palette stops for a mid-tone container.
    const bg = `hsl(${hue} 45% 60%)`;
    const fg = `hsl(${hue} 60% 18%)`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">` +
      `<rect width="48" height="48" rx="12" fill="${bg}"/>` +
      `<text x="24" y="31" text-anchor="middle" font-family="sans-serif" font-size="20" font-weight="500" fill="${fg}">${monogram(label)}</text>` +
      `</svg>`;
    return {
      packageName,
      dataUrl: `data:image/svg+xml;base64,${btoa(svg)}`,
    };
  }

  async getIconBatch({ packageNames, size = 128 }: { packageNames: string[]; size?: number }) {
    const icons = await Promise.all(
      packageNames.map((packageName) => this.getIcon({ packageName, size })),
    );
    return { icons };
  }

  async openAppInfo(): Promise<void> {
    console.info('[web] openAppInfo is a no-op outside Android');
  }

  async uninstall(): Promise<void> {
    console.info('[web] uninstall is a no-op outside Android');
  }

  async openInStore(): Promise<void> {
    console.info('[web] openInStore is a no-op outside Android');
  }

  async hasPackageVisibility() {
    return { granted: true };
  }

  async openPackageVisibilitySettings(): Promise<void> {
    console.info('[web] no package visibility settings outside Android');
  }
}

export class SystemThemeWeb implements SystemThemePlugin {
  async getPalette(): Promise<SystemPalette> {
    return {
      dynamicAvailable: false,
      accentArgb: null,
      neutralArgb: null,
      systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
      androidSdk: 0,
    };
  }

  async getThemeMode() {
    return { dark: window.matchMedia('(prefers-color-scheme: dark)').matches };
  }

  async addListener(
    _eventName: 'themeChanged',
    listener: (data: { dark: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }> {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => listener({ dark: e.matches });
    mql.addEventListener('change', handler);
    return {
      remove: async () => {
        mql.removeEventListener('change', handler);
      },
    };
  }
}

export class MorpheBridgeWeb implements MorpheBridgePlugin {
  async findMorpheInstalls() {
    return { installs: [] };
  }

  async openSourceLink({ url }: { url: string }): Promise<MorpheActionResult> {
    // Opened in a new tab so the link can be inspected during UI work. Reported
    // as not-delivered because a browser tab is not Morphe.
    window.open(url, '_blank', 'noopener');
    return { delivered: false, resolvedActivity: null, reason: 'web-preview' };
  }

  async openMorpheSettings(): Promise<MorpheActionResult> {
    return { delivered: false, resolvedActivity: null, reason: 'not-installed' };
  }
}
