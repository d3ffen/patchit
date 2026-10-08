import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * One HTTP path for both platforms, for a reason that is easy to get wrong.
 *
 * The plan was to revalidate the 2 MB community index with `If-None-Match`, so
 * a 304 would cost a few hundred bytes. That works in curl and does not work in
 * the WebView: `If-None-Match` is not a CORS-safelisted request header, so the
 * browser fires an OPTIONS preflight, and both hosts answer it with 403/405.
 * The request never happens.
 *
 * Capacitor's native HTTP client does the request in Kotlin, where CORS does
 * not exist, and hands back the status and headers. So:
 *
 *   native  -> CapacitorHttp, conditional GET, real ETag revalidation
 *   browser -> plain fetch, time-based freshness only (dev convenience)
 *
 * The call sites do not care which one ran; they get the same shape back.
 */

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
  /** True when the server answered 304 and the cached body should be reused. */
  notModified: boolean;
  /** How the request was actually made, for the diagnostics log. */
  transport: 'native' | 'fetch';
  durationMs: number;
}

export interface HttpRequestOptions {
  url: string;
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Header lookups are case-insensitive; servers disagree about casing. */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

export function getEtag(response: HttpResponse): string | null {
  return headerValue(response.headers, 'etag');
}

export function getLastModified(response: HttpResponse): string | null {
  return headerValue(response.headers, 'last-modified');
}

export async function httpGet(options: HttpRequestOptions): Promise<HttpResponse> {
  const started = performance.now();
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    };
    // Only send these when we actually have a cached copy; an unconditional
    // request avoids the preflight cost entirely on a cold start.
    if (options.etag) headers['If-None-Match'] = options.etag;
    if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;

    const response = await CapacitorHttp.request({
      url: options.url,
      method: 'GET',
      headers,
      responseType: 'text',
      connectTimeout: options.timeoutMs ?? 30_000,
      readTimeout: options.timeoutMs ?? 30_000,
    });

    const normalizedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      normalizedHeaders[key] = String(value);
    }

    // CapacitorHttp hands back a parsed object for JSON responses and a string
    // otherwise. The registry endpoints send `text/plain` (raw.githubusercontent)
    // and `application/json` (morphe-patches.software), so both paths are live.
    const body =
      typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? null);

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      body,
      headers: normalizedHeaders,
      notModified: response.status === 304,
      transport: 'native',
      durationMs: Math.round(performance.now() - started),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(options.url, {
      method: 'GET',
      // `no-cache` revalidates rather than reusing a stale HTTP cache entry.
      cache: 'no-cache',
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    return {
      status: response.status,
      ok: response.ok,
      body: response.status === 304 ? '' : await response.text(),
      headers,
      notModified: response.status === 304,
      transport: 'fetch',
      durationMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * A tiny concurrency limiter.
 *
 * Custom sources are fetched one per repo, and a user with thirty of them would
 * otherwise open thirty sockets at once — which Android's WebView will happily
 * throttle for us in the least helpful way possible.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
