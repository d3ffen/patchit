import { useEffect, useState } from 'react';
import {
  canInstallPackages,
  currentVersion,
  downloadRelease,
  formatBytes,
  installDownloaded,
  onDownloadProgress,
  openInstallPermissionSettings,
  type ReleaseInfo,
  type UpdateState,
} from '@/native/updater';
import { log } from '@/diagnostics/logger';
import { Icon } from '@/ui/icons';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  cx,
  useSnackbar,
} from '@/ui/primitives';

/**
 * In-app updater.
 *
 * The design decision here is that nothing installs itself. Android shows its
 * own installer, and on API 26+ the user has to grant PatchIt "install unknown
 * apps" before the hand-off is even accepted — so the flow is: tell them what is
 * new, download it, then hand it to the system and let Android ask.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; path: string }
  | { kind: 'failed'; message: string };

export function UpdateSheet({
  open,
  onClose,
  release,
  currentVersionLabel,
}: {
  open: boolean;
  onClose: () => void;
  release: ReleaseInfo;
  currentVersionLabel: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [percent, setPercent] = useState(0);
  const [needsPermission, setNeedsPermission] = useState(false);
  const { show } = useSnackbar();

  useEffect(() => {
    void canInstallPackages().then((allowed) => setNeedsPermission(!allowed));
  }, [open]);

  useEffect(() => onDownloadProgress(setPercent), []);

  useEffect(() => {
    if (!open) {
      setPhase({ kind: 'idle' });
      setPercent(0);
    }
  }, [open]);

  const start = async () => {
    setPhase({ kind: 'downloading', percent: 0 });
    const handle = downloadRelease(release);

    try {
      const { path } = await handle.done;
      handle.stopListening();
      setPhase({ kind: 'ready', path });

      const outcome = await installDownloaded(path);
      if (outcome.kind === 'needs-permission') {
        setNeedsPermission(true);
        show({ message: 'Allow PatchIt to install apps, then tap Install again.' });
      } else if (outcome.kind === 'failed') {
        log.warn('updater', `Installer hand-off failed: ${outcome.message}`);
        show({ message: outcome.message });
      }
    } catch (error) {
      handle.stopListening();
      const message = error instanceof Error ? error.message : String(error);
      log.error('updater', 'Download failed', error);
      setPhase({ kind: 'failed', message });
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={`PatchIt ${release.version}`}>
      <div className="px-6 pb-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">
            <Icon name="update" size={14} />
            {currentVersionLabel} → {release.version}
          </Badge>
          <Badge tone="neutral">{formatBytes(release.sizeBytes)}</Badge>
          {release.publishedAt && (
            <Badge tone="neutral">{new Date(release.publishedAt).toLocaleDateString()}</Badge>
          )}
        </div>

        {/* Release notes, kept as plain text: they are markdown upstream, and a
            half-rendered markdown block looks worse than none. */}
        {release.notes && (
          <Card tone="surface" className="mt-4 max-h-64 overflow-y-auto p-4">
            <p className="md-body-medium whitespace-pre-wrap text-on-surface-variant">
              {release.notes}
            </p>
          </Card>
        )}

        {needsPermission && (
          <div className="mt-4 rounded-md bg-warn-container p-4 text-on-warn-container">
            <div className="flex items-start gap-3">
              <Icon name="warning" size={20} className="mt-0.5 flex-none" />
              <div className="min-w-0 flex-1">
                <p className="md-title-small">Android needs your permission first</p>
                <p className="md-body-medium mt-1">
                  PatchIt can download the update, but Android will not install it until you allow
                  this app to install unknown apps.
                </p>
                <Button
                  variant="text"
                  icon="open-in-new"
                  className="mt-1 px-0"
                  onClick={() => void openInstallPermissionSettings()}
                >
                  Open the setting
                </Button>
              </div>
            </div>
          </div>
        )}

        {phase.kind === 'downloading' && (
          <div className="mt-4">
            <div className="flex items-baseline justify-between">
              <span className="md-label-large text-on-surface">Downloading…</span>
              <span className="md-label-large text-on-surface-variant">{percent}%</span>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-container-highest">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 ease-standard"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {phase.kind === 'failed' && (
          <div className="mt-4 rounded-md bg-error-container p-4 text-on-error-container">
            <p className="md-body-medium">{phase.message}</p>
          </div>
        )}

        <Divider className="my-4" />

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="text" onClick={onClose}>
            Later
          </Button>
          <Button
            icon={phase.kind === 'ready' ? 'install' : 'download'}
            loading={phase.kind === 'downloading'}
            disabled={phase.kind === 'downloading'}
            onClick={() => {
              if (phase.kind === 'ready') {
                void installDownloaded(phase.path).then((outcome) => {
                  if (outcome.kind === 'needs-permission') setNeedsPermission(true);
                });
                return;
              }
              void start();
            }}
          >
            {phase.kind === 'ready' ? 'Install' : 'Download and install'}
          </Button>
        </div>

        <p className="md-body-small mt-3 text-on-surface-variant">
          Android will show its own installer and ask you to confirm. PatchIt never replaces itself
          silently.
        </p>
      </div>
    </BottomSheet>
  );
}

/** The row in Settings, and the banner on the app list, share this summary. */
export function UpdateRow({
  state,
  onOpen,
  onRecheck,
}: {
  state: UpdateState;
  onOpen: () => void;
  onRecheck: () => void;
}) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    void currentVersion().then(setVersion);
  }, [state]);

  const available = state.kind === 'available';

  return (
    <Card variant="outlined" className="mx-4 overflow-hidden p-0">
      <div className="flex items-start gap-4 p-4">
        <div
          className={cx(
            'grid size-10 flex-none place-items-center rounded-md',
            available
              ? 'bg-primary-container text-on-primary-container'
              : 'bg-surface-container-high text-on-surface-variant',
          )}
        >
          <Icon name={available ? 'update' : 'check-circle'} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="md-body-large text-on-surface">
            PatchIt {version}
            {available ? ` → ${state.release.version}` : ''}
          </p>
          <p className="md-body-medium text-on-surface-variant">
            {state.kind === 'idle' || state.kind === 'checking'
              ? 'Checking for updates…'
              : available
                ? `Version ${state.release.version} is available.`
                : state.kind === 'error'
                  ? state.message
                  : 'You are on the latest version.'}
          </p>
        </div>
      </div>
      <Divider />
      <div className="flex justify-end gap-2 p-2">
        <Button variant="text" icon="refresh" onClick={onRecheck}>
          Check
        </Button>
        {available && (
          <Button icon="download" onClick={onOpen}>
            Update
          </Button>
        )}
      </div>
    </Card>
  );
}
