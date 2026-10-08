/**
 * Diagnostics log.
 *
 * Every non-obvious failure in this app is invisible at the UI level: a bundle
 * that failed to parse, a signature that did not match, a Morphe intent that
 * resolved to nothing. Without a log the user sees an app that "just doesn't
 * find patches", which is unactionable.
 *
 * This is an in-memory ring buffer with an external store subscription, plus
 * global capture of uncaught errors. It is deliberately not `console.*`: those
 * disappear the moment the WebView's devtools are closed, which on a release
 * Android build is always.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  /** Serialisable context. Kept as a string so the buffer cannot retain objects. */
  detail?: string;
  /** Error stack, when the entry came from a thrown value. */
  stack?: string;
}

const MAX_ENTRIES = 500;

let nextId = 1;
let entries: LogEntry[] = [];
const listeners = new Set<(entries: LogEntry[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(entries);
}

function push(entry: Omit<LogEntry, 'id' | 'at'>): void {
  const full: LogEntry = { ...entry, id: nextId, at: Date.now() };
  nextId += 1;

  // Ring buffer: drop from the head rather than growing without bound. 500
  // entries is roughly a full sync plus a scan plus their fallout.
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), full] : [...entries, full];
  emit();
}

function serialise(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, (_key, v) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === 'bigint') return v.toString();
      return v;
    });
  } catch {
    return String(value);
  }
}

export const log = {
  debug(scope: string, message: string, detail?: unknown): void {
    push({ level: 'debug', scope, message, detail: serialise(detail) });
  },
  info(scope: string, message: string, detail?: unknown): void {
    push({ level: 'info', scope, message, detail: serialise(detail) });
  },
  warn(scope: string, message: string, detail?: unknown): void {
    push({ level: 'warn', scope, message, detail: serialise(detail) });
  },
  error(scope: string, message: string, error?: unknown): void {
    const stack = error instanceof Error ? error.stack : undefined;
    push({
      level: 'error',
      scope,
      message,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : serialise(error),
      stack,
    });
  },
};

export function subscribe(listener: (entries: LogEntry[]) => void): () => void {
  listeners.add(listener);
  listener(entries);
  return () => listeners.delete(listener);
}

export function clear(): void {
  entries = [];
  emit();
}

/** Plain-text export, for sharing a bug report through Android's share sheet. */
export function exportText(): string {
  const header = [
    'PatchIt — diagnostics',
    `exported: ${new Date().toISOString()}`,
    `entries: ${entries.length}`,
    '',
  ].join('\n');

  const body = entries
    .map((e) => {
      const time = new Date(e.at).toISOString().slice(11, 23);
      const lines = [`${time} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}`];
      if (e.detail) lines.push(`      ${e.detail}`);
      if (e.stack) lines.push(e.stack.split('\n').slice(1, 4).map((l) => `      ${l.trim()}`).join('\n'));
      return lines.filter(Boolean).join('\n');
    })
    .join('\n');

  return `${header}${body}\n`;
}

export function counts(): Record<LogLevel, number> {
  const out: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const entry of entries) out[entry.level] += 1;
  return out;
}

/**
 * Install global handlers. Returns a teardown function.
 *
 * React error boundaries catch render errors, but not a rejected promise from a
 * fire-and-forget sync or a throw inside a native callback — and those are
 * exactly the failures that leave the UI silently wrong.
 */
export function installGlobalHandlers(): () => void {
  const onError = (event: ErrorEvent) => {
    log.error('window', event.message || 'Uncaught error', event.error);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    log.error('window', 'Unhandled promise rejection', event.reason);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
