import type { AppUpdaterPlugin } from './updater';

/**
 * Browser stand-in for the updater.
 *
 * The web build exists to iterate on the UI in a desktop browser, so this
 * reports a download that completes over a second or so. That makes the whole
 * update flow — card, progress bar, install hand-off — reachable with
 * `npm run dev` instead of a Gradle build and a device.
 */
export class AppUpdaterWeb implements AppUpdaterPlugin {
  private listeners: ((data: { percent: number; bytes: number; total: number }) => void)[] = [];

  async download(options: { url: string; fileName: string }) {
    for (let percent = 0; percent <= 100; percent += 10) {
      await new Promise((resolve) => setTimeout(resolve, 90));
      for (const listener of this.listeners) {
        listener({ percent, bytes: percent * 1000, total: 100_000 });
      }
    }
    return { path: `/dev/null/${options.fileName}`, fileName: options.fileName, bytes: 100_000 };
  }

  async install() {
    // A browser tab cannot install an APK, and pretending otherwise would hide
    // the Android-only branch from whoever is working on the UI.
    return { launched: false, reason: 'web' };
  }

  async canInstall() {
    return { allowed: false };
  }

  async openInstallSettings(): Promise<void> {
    console.info('[web] install-permission settings are Android-only');
  }

  async clearDownloads(): Promise<void> {
    /* nothing to clear in a browser */
  }

  async addListener(
    _eventName: 'downloadProgress',
    listener: (data: { percent: number; bytes: number; total: number }) => void,
  ) {
    this.listeners.push(listener);
    return {
      remove: async () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      },
    };
  }
}
