import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { log } from '@/diagnostics/logger';

/**
 * Real app icons for packages that are not installed.
 *
 * Android only hands out icons for packages it actually has. `PackageManager`
 * has no "give me the icon of this package id" call, so for an app you do not
 * own there is nothing on the device to draw. The icon has to come from
 * somewhere else, and the only place that reliably has one for a given package
 * id is the Play Store listing.
 *
 * How it works: fetch the listing page, read the `og:image` tag, and request the
 * same image at a small size. The page is ~1.3 MB of HTML to extract one URL,
 * which is why this is *lazy and permanent* — fetched the first time somebody
 * looks at a specific app, then cached forever, never for the whole registry at
 * once.
 *
 * This is scraping, and worth being honest about:
 *
 *  - There is no public API for this, so a Play redesign can break it. Every
 *    failure path returns null and the caller falls back to a monogram, so the
 *    worst case is a plain letter tile rather than an error.
 *  - It only covers apps published on Play. Region-locked, delisted or sideloaded
 *    packages have no listing and fall back the same way.
 *  - The icon itself is served from `play-lh.googleusercontent.com`, which needs
 *    no page fetch at all once we know the hash — so the expensive part happens
 *    exactly once per package, ever.
 */

/* ------------------------------------------------------------------ *
 * Fetch queue
 * ------------------------------------------------------------------ */

/**
 * Play icon lookups run through a small queue.
 *
 * Each lookup costs ~1.3 MB of HTML, and a list of registry packages can mount
 * several hundred icons at once. Firing those concurrently does not just hammer
 * Google — it allocates hundreds of megabytes of response bodies in the WebView
 * and takes the app down with it. Three at a time keeps the pipeline full
 * without the spike.
 */
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await task();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/**
 * In-flight lookups, keyed by package.
 *
 * A row can mount, unmount and remount while scrolling, and the same package can
 * appear in more than one place. Without this, every remount starts the whole
 * 1.3 MB fetch again.
 */
const inFlight = new Map<string, Promise<string | null>>();

/** Small enough to be a rounding error in the cache, big enough for a 48dp tile. */
const ICON_SIZE = 128;

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

/** og:image, in either attribute order, with single or double quotes. */
const OG_IMAGE = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i;
const OG_IMAGE_REVERSED = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i;

/**
 * Rewrite the size suffix on a Play image URL.
 *
 * These URLs end in a directive like `=s0-br30` or `=w240`. Requesting the
 * original hands back a 512px PNG; `=w128` is ~6 KB. If the shape is ever
 * different to what we expect, the URL is returned untouched rather than
 * corrupted.
 */
function resizePlayImage(url: string, size: number): string {
  const match = url.match(/=([swh]\d+[^/]*)$/);
  if (!match) return url;
  return `${url.slice(0, url.length - match[0].length)}=w${size}`;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.request({
        url,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        responseType: 'text',
        connectTimeout: 15_000,
        readTimeout: 20_000,
      });
      if (response.status < 200 || response.status >= 300) return null;
      return typeof response.data === 'string' ? response.data : null;
    }

    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    return response.ok ? await response.text() : null;
  } catch (error) {
    log.debug('icons', `Play listing fetch failed for ${url}`, error);
    return null;
  }
}

async function fetchImageDataUrl(url: string): Promise<string | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      // Capacitor returns binary as a base64 string when asked for an
      // arraybuffer, which is exactly the shape a data URL needs — no decoding
      // round-trip through the bridge.
      const response = await CapacitorHttp.request({
        url,
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        responseType: 'arraybuffer',
        connectTimeout: 15_000,
        readTimeout: 20_000,
      });
      if (response.status < 200 || response.status >= 300) return null;
      if (typeof response.data !== 'string' || response.data.length === 0) return null;
      return `data:image/png;base64,${response.data}`;
    }

    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return `data:image/png;base64,${btoa(binary)}`;
  } catch (error) {
    log.debug('icons', `Play icon download failed for ${url}`, error);
    return null;
  }
}

/**
 * Look up an app's icon on the Play Store.
 *
 * Returns a small PNG as a data URL, or null for anything that goes wrong —
 * not published, delisted, region-locked, rate-limited, markup changed. Null is
 * an ordinary outcome here, not an error, because the caller has a fallback.
 */
export async function fetchPlayIcon(packageName: string): Promise<string | null> {
  // Cheap sanity check: a Play lookup for something that is not a package id is
  // a wasted 1.3 MB.
  if (!packageName.includes('.')) return null;

  const existing = inFlight.get(packageName);
  if (existing) return existing;

  const task = withSlot(() => lookupPlayIcon(packageName)).finally(() => {
    inFlight.delete(packageName);
  });
  inFlight.set(packageName, task);
  return task;
}

async function lookupPlayIcon(packageName: string): Promise<string | null> {

  const listing = await fetchText(
    `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=en&gl=US`,
  );
  if (!listing) return null;

  const match = listing.match(OG_IMAGE) ?? listing.match(OG_IMAGE_REVERSED);
  const raw = match?.[1];
  if (!raw || !raw.startsWith('https://')) return null;

  const icon = await fetchImageDataUrl(resizePlayImage(raw, ICON_SIZE));
  if (icon) log.debug('icons', `Fetched Play icon for ${packageName}`);
  return icon;
}
