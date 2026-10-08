import { useEffect, useMemo, useRef, useState } from 'react';
import { clear, counts, exportText, subscribe, type LogEntry, type LogLevel } from '@/diagnostics/logger';
import { useStore } from '@/state/store';
import { Icon, type IconName } from '@/ui/icons';
import { Scaffold, TopAppBar } from '@/ui/layout';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Segmented,
  cx,
  useSnackbar,
} from '@/ui/primitives';

/**
 * The diagnostics drawer.
 *
 * Almost every real failure in this app is a *mismatch*: the registry says one
 * thing, the device says another, and the UI shows the resulting verdict with no
 * explanation of how it got there. This screen is the explanation, and it is the
 * difference between a bug report that says "it doesn't work" and one that says
 * "bundle X declares 7.16.51, my device is 7.16.51.2, and the loose matcher
 * rejected it".
 *
 * Newest-first by default, because the interesting entry is almost always the
 * last one.
 */

const LEVEL_META: Record<LogLevel, { icon: IconName; tone: string; label: string }> = {
  debug: { icon: 'terminal', tone: 'text-on-surface-variant', label: 'Debug' },
  info: { icon: 'info', tone: 'text-primary', label: 'Info' },
  warn: { icon: 'warning', tone: 'text-warn', label: 'Warn' },
  error: { icon: 'error', tone: 'text-error', label: 'Error' },
};

export function LogsScreen({ onClose }: { onClose: () => void }) {
  const { snapshot, snapshotOrigin, lastScanAt, lastSyncAt, apps, sources, syncMeta } =
    useLogsContext();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const { show } = useSnackbar();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(setEntries), []);

  const tally = useMemo(() => counts(), [entries]);

  const visible = useMemo(() => {
    const filtered = level === 'all' ? entries : entries.filter((e) => e.level === level);
    return newestFirst ? [...filtered].reverse() : filtered;
  }, [entries, level, newestFirst]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(exportText());
      show({ message: `Copied ${entries.length} log entries.` });
    } catch {
      show({ message: 'Could not access the clipboard.' });
    }
  };

  const share = async () => {
    const text = exportText();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'PatchIt log', text });
        return;
      } catch {
        // User cancelled, or the WebView has no share target. Fall through.
      }
    }
    await copyAll();
  };

  return (
    <Scaffold
      appBar={
        <TopAppBar
          onBack={onClose}
          title="Diagnostics"
          subtitle={`${entries.length} entries · ${tally.error} errors · ${tally.warn} warnings`}
          actions={
            <>
              <IconButton
                icon="sort"
                label={newestFirst ? 'Showing newest first' : 'Showing oldest first'}
                selected={newestFirst}
                onClick={() => setNewestFirst((v) => !v)}
              />
              <IconButton icon="share" label="Share log" onClick={() => void share()} />
              <IconButton
                icon="delete"
                label="Clear log"
                onClick={() => {
                  clear();
                  show({ message: 'Log cleared.' });
                }}
              />
            </>
          }
        />
      }
    >
      <div className="px-4 pt-4">
        <Segmented
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: `All ${entries.length}` },
            { value: 'warn', label: `Warn ${tally.warn}` },
            { value: 'error', label: `Error ${tally.error}` },
            { value: 'info', label: `Info ${tally.info}` },
          ]}
        />
      </div>

      {/* --- Environment snapshot --------------------------------- */}
      <div className="mt-4 px-4">
        <Card variant="outlined" className="p-4">
          <h3 className="md-title-small mb-2 text-primary">Environment</h3>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">
              <Icon name="apps" size={12} />
              {apps.length} packages scanned
            </Badge>
            <Badge tone="neutral">
              <Icon name="source" size={12} />
              {sources.length} sources
            </Badge>
            {snapshot && (
              <Badge tone="neutral">
                <Icon name="database" size={12} />
                {snapshot.bundles.length} bundles
              </Badge>
            )}
            {snapshotOrigin && (
              <Badge tone={snapshotOrigin === 'live' ? 'ok' : 'warn'}>
                <Icon name={snapshotOrigin === 'live' ? 'check' : 'cloud-off'} size={12} />
                {snapshotOrigin === 'live' ? 'synced' : 'bundled seed'}
              </Badge>
            )}
            {syncMeta && (
              <Badge tone="neutral">
                <Icon name="speed" size={12} />
                scan {syncMeta.durationMs} ms
              </Badge>
            )}
            {syncMeta && <Badge tone="neutral">device SDK {syncMeta.deviceSdk}</Badge>}
          </div>
          <p className="md-body-small mt-2 text-on-surface-variant">
            Last scan {lastScanAt ? new Date(lastScanAt).toLocaleTimeString() : '—'} · last sync{' '}
            {lastSyncAt ? new Date(lastSyncAt).toLocaleTimeString() : '—'}
          </p>
        </Card>
      </div>

      {/* --- Entries ---------------------------------------------- */}
      {visible.length === 0 ? (
        <EmptyState
          icon="terminal"
          title="Nothing logged yet"
          body="Run a scan or a sync, and every decision the app makes will show up here."
        />
      ) : (
        <div ref={scroller} className="mt-4 flex flex-col">
          {visible.map((entry) => {
            const meta = LEVEL_META[entry.level];
            const isOpen = expanded === entry.id;
            const hasDetail = Boolean(entry.detail || entry.stack);

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setExpanded(isOpen ? null : entry.id)}
                className="state-layer flex w-full items-start gap-3 px-4 py-2 text-left"
              >
                <Icon name={meta.icon} size={16} className={cx('mt-0.5 flex-none', meta.tone)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="md-label-small flex-none text-on-surface-variant">
                      {new Date(entry.at).toLocaleTimeString()}
                    </span>
                    <span className={cx('md-label-small flex-none', meta.tone)}>{entry.scope}</span>
                  </div>
                  <p
                    className={cx(
                      'md-body-medium break-words text-on-surface',
                      !isOpen && 'line-clamp-2',
                    )}
                  >
                    {entry.message}
                  </p>
                  {isOpen && hasDetail && (
                    <pre className="md-body-small mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-container-highest p-3 font-mono text-on-surface-variant">
                      {entry.detail}
                      {entry.stack ? `\n\n${entry.stack}` : ''}
                    </pre>
                  )}
                </div>
                {hasDetail && (
                  <Icon
                    name={isOpen ? 'chevron-down' : 'chevron-right'}
                    size={16}
                    className="mt-0.5 flex-none text-on-surface-variant"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-2 px-4">
        <Button variant="tonal" icon="copy" onClick={() => void copyAll()}>
          Copy as text
        </Button>
        <Button variant="outlined" icon="share" onClick={() => void share()}>
          Share
        </Button>
      </div>
      <div className="h-6" />
    </Scaffold>
  );
}

/** Small adapter so the screen reads the two shapes it needs without coupling. */
function useLogsContext() {
  const { snapshot, snapshotOrigin, lastScanAt, lastSyncAt, apps, sources, scanMeta } = useStore();
  return { snapshot, snapshotOrigin, lastScanAt, lastSyncAt, apps, sources, syncMeta: scanMeta };
}
