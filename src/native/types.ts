/**
 * Wire types shared between the React app and the Kotlin plugins.
 *
 * These are the *contract*. `ScannerPlugin.kt`, `SystemThemePlugin.kt` and
 * `MorpheBridgePlugin.kt` must keep their field names in step with this file;
 * a rename on one side without the other is the classic Capacitor bug, so the
 * Kotlin side repeats these names in its own data classes on purpose.
 */

export interface InstalledApp {
  packageName: string;
  label: string;
  versionName: string;
  versionCode: number;
  /** Flagship "system" status from ApplicationInfo.FLAG_SYSTEM. */
  isSystem: boolean;
  /** A system app that has been updated on /data, so it is patchable like a user app. */
  isUpdatedSystemApp: boolean;
  isEnabled: boolean;
  /** Permanently disabled by the user (pm disable-user) — no APK to patch. */
  isSuspended: boolean;
  /** Absolute path of the base APK, i.e. PackageInfo.applicationInfo.sourceDir. */
  sourceDir: string;
  /** Paths of the config splits, empty for a single-APK install. */
  splitSourceDirs: string[];
  /** True when the install is a split/app-bundle install (APKM/APKS territory). */
  hasSplits: boolean;
  uid: number;
  targetSdk: number;
  minSdk: number;
  /** SHA-256 of the signing certificate, uppercase hex, no separators. Null if unreadable. */
  signatureSha256: string | null;
  firstInstallTime: number;
  lastUpdateTime: number;
  apkSizeBytes: number;
}

export interface ScanOptions {
  /** Include apps flagged FLAG_SYSTEM. */
  includeSystem?: boolean;
  /** Include apps whose install is split across multiple APKs. */
  includeSplits?: boolean;
  /** Exclude apps that are themselves Morphe patch managers/loaders. */
  excludeMorphe?: boolean;
}

export interface ScanResult {
  apps: InstalledApp[];
  /** Wall-clock duration of the native enumeration, for the diagnostics log. */
  durationMs: number;
  /** Apps the scan deliberately skipped, and why. Reported, never silently dropped. */
  skipped: { packageName: string; reason: string }[];
  deviceSdk: number;
  /** True when QUERY_ALL_PACKAGES is granted and the list is genuinely complete. */
  fullVisibility: boolean;
}

export interface IconResult {
  packageName: string;
  /** `data:image/png;base64,...`, or null when the icon could not be rendered. */
  dataUrl: string | null;
}

export interface MorpheInstall {
  packageName: string;
  label: string;
  versionName: string;
  /** The activity that accepts our intents; null when the app is installed but inert. */
  launcherActivity: string | null;
  /**
   * True when this install resolves `https://morphe.software/add-source`.
   * A Morphe build that does not is a dead end for the one hand-off we make, so
   * the UI can say so instead of failing at the tap.
   */
  handlesSourceLinks: boolean;
}

export interface SystemPalette {
  /** True when the device is Android 12+ and actually exposes a Monet palette. */
  dynamicAvailable: boolean;
  /** ARGB integer of the wallpaper's primary accent, when available. */
  accentArgb: number | null;
  /** ARGB integer of `system_neutral1_500`, a good seed for the surface roles. */
  neutralArgb: number | null;
  /** How the OS itself is currently themed. */
  systemDark: boolean;
  androidSdk: number;
}

/**
 * Outcome of any hand-off to Morphe.
 *
 * The two calls that use it — opening an add-source link, and opening Morphe
 * itself — can both fail in ways the user needs told apart, so `reason` is
 * carried rather than collapsed into a boolean.
 */
export interface MorpheActionResult {
  delivered: boolean;
  /** Which activity consumed the intent, for the log. */
  resolvedActivity: string | null;
  /** Set when nothing usable handled the request. */
  reason?: 'not-installed' | 'no-activity' | 'security-exception' | 'unknown' | string;
  message?: string;
}
