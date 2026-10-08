import { Capacitor, registerPlugin } from '@capacitor/core';
import type {
  IconResult,
  ScanOptions,
  ScanResult,
  SystemPalette,
  MorpheInstall,
  MorpheActionResult,
} from './types';

/**
 * Three plugins rather than one.
 *
 * The split is by *permission and lifecycle*, not by convenience:
 *  - `AppScanner` needs QUERY_ALL_PACKAGES and does genuinely expensive work on
 *    a background thread.
 *  - `SystemTheme` is called once at boot and must answer even when package
 *    visibility is denied.
 *  - `MorpheBridge` fires intents into another app, which can throw
 *    ActivityNotFoundException / SecurityException and needs its own error path.
 *
 * Bundling them would force every theme read to drag the scanner's permission
 * requirements along with it.
 */

export interface AppScannerPlugin {
  scan(options?: ScanOptions): Promise<ScanResult>;
  getIcon(options: { packageName: string; size?: number }): Promise<IconResult>;
  getIconBatch(options: { packageNames: string[]; size?: number }): Promise<{ icons: IconResult[] }>;
  openAppInfo(options: { packageName: string }): Promise<void>;
  openInStore(options: { packageName: string }): Promise<void>;
  /** Cheap check used by the empty state before offering the permission deep link. */
  hasPackageVisibility(): Promise<{ granted: boolean }>;
  openPackageVisibilitySettings(): Promise<void>;
}

export interface SystemThemePlugin {
  getPalette(): Promise<SystemPalette>;
  /** Reads the OS light/dark setting; the WebView's prefers-color-scheme can lag it. */
  getThemeMode(): Promise<{ dark: boolean }>;
  addListener(
    eventName: 'themeChanged',
    listener: (data: { dark: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

/**
 * Note what this interface does *not* have: any way to ask Morphe to patch
 * something. The scanner tells you what is patchable and makes sure Morphe has
 * the sources to do it; the patching itself stays in Morphe's own UI, where the
 * user sees the full picture before anything is installed.
 */
export interface MorpheBridgePlugin {
  /** Every installed app that looks like a Morphe manager/patcher. */
  findMorpheInstalls(): Promise<{ installs: MorpheInstall[] }>;
  /** Deep links `https://morphe.software/add-source?github=owner/repo` into Morphe. */
  openSourceLink(options: { url: string }): Promise<MorpheActionResult>;
  /** Opens Morphe itself, for the actions that have no deep link. */
  openMorpheSettings(options: { packageName: string }): Promise<MorpheActionResult>;
}

/**
 * The `web` implementations exist so `npm run dev` in a desktop browser gives a
 * usable app against fake data. That is not a nicety: iterating on this UI
 * against a real device costs a Gradle build and a reinstall per change.
 */
export const AppScanner = registerPlugin<AppScannerPlugin>('AppScanner', {
  web: () => import('./web').then((m) => new m.AppScannerWeb()),
});

export const SystemTheme = registerPlugin<SystemThemePlugin>('SystemTheme', {
  web: () => import('./web').then((m) => new m.SystemThemeWeb()),
});

export const MorpheBridge = registerPlugin<MorpheBridgePlugin>('MorpheBridge', {
  web: () => import('./web').then((m) => new m.MorpheBridgeWeb()),
});

export const isNative = (): boolean => Capacitor.isNativePlatform();

export type { InstalledApp, ScanResult, ScanOptions, SystemPalette, IconResult } from './types';
