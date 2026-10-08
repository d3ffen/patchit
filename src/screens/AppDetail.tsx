import { useMemo, useState } from 'react';
import type { AppMatch, PatchMatch, Verdict } from '@/core/compatibility';
import { addRepoToMorphe, addReposToMorphe, addableRepos, isBuiltIn } from '@/core/morphe';
import { AppScanner, MorpheBridge } from '@/native/plugins';
import { useStore } from '@/state/store';
import { sortVersions } from '@/core/version';
import { log } from '@/diagnostics/logger';
import { AppIcon, SignatureBadge, VERDICT_PRESENTATION, VerdictBadge } from '@/ui/indicators';
import { Icon } from '@/ui/icons';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  type CardTone,
  Chip,
  Divider,
  IconButton,
  ListItem,
  cx,
  useSnackbar,
} from '@/ui/primitives';

/**
 * The per-app breakdown — where the app earns its keep.
 *
 * A verdict on its own ("Too new") is not actionable. This sheet answers the
 * four questions a user actually has: which sources cover this app, which
 * patches apply right now, what version should I be on, and what exactly is the
 * tool looking at. The last one matters more than it looks: showing the raw
 * match object is what makes a wrong verdict debuggable instead of mysterious.
 */
export function AppDetail({
  match,
  onClose,
  onShowLog,
}: {
  match: AppMatch | null;
  onClose: () => void;
  onShowLog: () => void;
}) {
  const { show } = useSnackbar();
  const { morpheInstalls } = useStore();
  const [rawOpen, setRawOpen] = useState(false);

  const versions = useMemo(() => (match ? sortVersions(match.supportedVersions) : []), [match]);
  const repos = useMemo(() => (match ? addableRepos(match) : []), [match]);
  const morpheReady = morpheInstalls.some((install) => install.handlesSourceLinks);

  if (!match) return null;

  const presentation = VERDICT_PRESENTATION[match.verdict];
  const { app } = match;

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      show({ message: `${label} copied.` });
    } catch (error) {
      log.warn('ui', 'Clipboard write failed', error);
      show({ message: 'Could not access the clipboard.' });
    }
  };

  const openStore = async () => {
    try {
      await AppScanner.openInStore({ packageName: app.packageName });
    } catch (error) {
      log.warn('ui', 'Play Store link failed', error);
      show({ message: 'No store app handled the link.' });
    }
  };

  const openInfo = async () => {
    try {
      await AppScanner.openAppInfo({ packageName: app.packageName });
    } catch (error) {
      log.warn('ui', 'App info failed', error);
      show({ message: 'Could not open the system app info.' });
    }
  };

  return (
    <BottomSheet open={Boolean(match)} onClose={onClose} fullHeight>
      {/* --- Identity --------------------------------------------- */}
      <div className="flex items-start gap-4 px-6 pb-4">
        <AppIcon packageName={app.packageName} label={app.label} size={56} />
        <div className="min-w-0 flex-1">
          <h3 className="md-title-large truncate text-on-surface">{app.label}</h3>
          <button
            type="button"
            onClick={() => void copy(app.packageName, 'Package name')}
            className="md-body-small mt-0.5 flex items-center gap-1 text-on-surface-variant"
          >
            {app.packageName}
            <Icon name="copy" size={14} />
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              <Icon name="apps" size={14} />
              {app.versionName || `code ${app.versionCode}`}
            </Badge>
            {app.versionName && app.versionCode ? (
              <Badge tone="neutral">code {app.versionCode}</Badge>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- Verdict ---------------------------------------------- */}
      <div className="px-6">
        <Card tone={VERDICT_TONE[match.verdict]} className="p-4">
          <div className="flex items-center gap-3">
            <Icon name={presentation.icon} size={24} />
            <div className="min-w-0 flex-1">
              <p className="md-title-medium">{presentation.label}</p>
              <p className="md-body-medium opacity-90">{presentation.hint}</p>
            </div>
          </div>

          {match.notes.length > 0 && (
            <ul className="md-body-small mt-3 flex list-disc flex-col gap-1 pl-5 opacity-90">
              {match.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </Card>

        <div className="mt-3 flex flex-wrap gap-2">
          <SignatureBadge verdict={match.signature} />
          <Badge tone="primary">
            <Icon name="extension" size={14} />
            {match.usablePatchCount} of {match.totalPatchCount} patches fit
          </Badge>
          <Badge tone="neutral">
            <Icon name="source" size={14} />
            {match.bundles.length} source{match.bundles.length === 1 ? '' : 's'}
          </Badge>
        </div>
      </div>

      {/* --- Versions --------------------------------------------- */}
      {versions.length > 0 && (
        <div className="mt-6 px-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h4 className="md-title-small text-primary">Supported versions</h4>
            {match.recommendedVersion && (
              <span className="md-label-medium text-on-surface-variant">
                nearest: {match.recommendedVersion}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {versions.slice(-12).map((version) => {
              const isInstalled = version === app.versionName;
              const isRecommended = version === match.recommendedVersion;
              return (
                <Chip
                  key={version}
                  selected={isInstalled}
                  checkOnSelect
                  accent={isRecommended && !isInstalled}
                  icon={isRecommended && !isInstalled ? 'star' : undefined}
                  onClick={() => void copy(version, 'Version')}
                >
                  {version}
                </Chip>
              );
            })}
            {versions.length > 12 && (
              <Badge tone="neutral">+{versions.length - 12} older</Badge>
            )}
          </div>
          {!versions.includes(app.versionName) && match.recommendedVersion && (
            <p className="md-body-small mt-2 text-on-surface-variant">
              Your build is not in the list. {match.recommendedVersion} is the closest version the
              sources know to work.
            </p>
          )}
        </div>
      )}

      {/* --- Per-source breakdown --------------------------------- */}
      <div className="mt-6">
        <h4 className="md-title-small px-6 pb-2 text-primary">Sources</h4>
        {match.bundles.map((bundleMatch) => (
          <BundleCard
            key={bundleMatch.bundle.id}
            match={bundleMatch}
            onNotify={(message) => show({ message })}
          />
        ))}
      </div>

      {/* --- Universal patches ------------------------------------ */}
      {match.universalPatches.length > 0 && (
        <div className="mt-6 px-6">
          <h4 className="md-title-small mb-1 text-primary">
            Universal patches ({match.universalPatches.length})
          </h4>
          <p className="md-body-small mb-2 text-on-surface-variant">
            These sources publish patches that apply to any app, so they are not counted towards
            this app&rsquo;s verdict. Morphe will offer them in its own list.
          </p>
          <Card variant="outlined" className="overflow-hidden p-0">
            {match.universalPatches.slice(0, 6).map((patchMatch, index) => (
              <div key={patchMatch.patch.id}>
                {index > 0 && <Divider inset />}
                <PatchRow match={patchMatch} muted />
              </div>
            ))}
          </Card>
          {match.universalPatches.length > 6 && (
            <p className="md-body-small mt-2 text-on-surface-variant">
              …and {match.universalPatches.length - 6} more from{' '}
              {new Set(match.universalPatches.map((p) => p.bundle.name)).size} sources.
            </p>
          )}
        </div>
      )}

      {/* --- Device facts ----------------------------------------- */}
      <div className="mt-6 px-6">
        <h4 className="md-title-small mb-2 text-primary">Install</h4>
        <Card variant="outlined" className="overflow-hidden p-0">
          <ListItem
            headline="APK path"
            supporting={<span className="md-body-small break-all">{app.sourceDir}</span>}
            trailing={
              <IconButton
                icon="copy"
                label="Copy APK path"
                size={18}
                onClick={() => void copy(app.sourceDir, 'APK path')}
              />
            }
          />
          <Divider inset />
          <ListItem
            headline={`${app.hasSplits ? `${app.splitSourceDirs.length + 1} APK splits` : 'Single APK'}`}
            supporting={`${(app.apkSizeBytes / (1024 * 1024)).toFixed(1)} MB · target SDK ${app.targetSdk} · min SDK ${app.minSdk}`}
          />
          <Divider inset />
          <ListItem
            headline={app.isSystem ? 'System app' : 'User app'}
            supporting={
              app.isUpdatedSystemApp
                ? 'A system app that has been updated, so it is patchable like a user app.'
                : app.isSystem
                  ? 'Preinstalled. Morphe usually refuses these.'
                  : `Installed ${new Date(app.firstInstallTime).toLocaleDateString()}`
            }
          />
        </Card>
      </div>

      {/* --- Actions ---------------------------------------------- */}
      {/*
        The primary action is adding sources, not patching. This screen answers
        "can this be patched, and by whom"; Morphe applies the patch, with the
        user seeing exactly what will change before anything is installed.
      */}
      <div className="mt-6 px-6">
        {repos.length > 0 ? (
          <>
            <Button
              fullWidth
              icon="add"
              onClick={async () => {
                const outcome = await addReposToMorphe(repos);
                show({ message: outcome.message });
              }}
            >
              {repos.length === 1
                ? 'Add this source to Morphe'
                : `Add ${repos.length} sources to Morphe`}
            </Button>
            {match.usablePatchCount === 0 && (
              <p className="md-body-small mt-2 px-1 text-on-surface-variant">
                These sources cover this app but not the build installed here, so Morphe will list
                it as a version mismatch. Add them anyway if you plan to update or downgrade — the
                supported versions are above.
              </p>
            )}
          </>
        ) : (
          <Card tone="surface" className="p-4">
            <p className="md-body-medium text-on-surface-variant">
              {match.bundles.length === 0
                ? 'No source in the registry covers this app.'
                : 'The only source covering this app is the official patch set, which Morphe already has.'}
            </p>
          </Card>
        )}

        {!morpheReady && repos.length > 0 && (
          <div className="mt-3 flex items-start gap-3 rounded-md bg-warn-container px-4 py-3 text-on-warn-container">
            <Icon name="warning" size={20} className="mt-0.5 flex-none" />
            <p className="md-body-medium">
              Morphe Manager was not found on this device, so there is nowhere to add the source.
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="tonal" icon="apps" onClick={() => void openInfo()}>
            App info
          </Button>
          <Button variant="outlined" icon="open-in-new" onClick={() => void openStore()}>
            Play Store
          </Button>
          {morpheInstalls.length > 0 && (
            <Button
              variant="outlined"
              icon="send"
              onClick={async () => {
                const result = await MorpheBridge.openMorpheSettings({
                  packageName: morpheInstalls[0].packageName,
                });
                if (!result.delivered) show({ message: 'Could not open Morphe Manager.' });
              }}
            >
              Open Morphe
            </Button>
          )}
        </div>
      </div>

      {/* --- Raw data --------------------------------------------- */}
      <div className="mt-6 px-6">
        <button
          type="button"
          onClick={() => setRawOpen((open) => !open)}
          className="md-title-small flex items-center gap-1 text-primary"
        >
          <Icon name={rawOpen ? 'chevron-down' : 'chevron-right'} size={18} />
          Match details
        </button>
        {rawOpen && (
          <pre className="md-body-small mt-2 max-h-64 overflow-auto rounded-md bg-surface-container-highest p-4 font-mono text-on-surface-variant">
            {JSON.stringify(
              {
                packageName: app.packageName,
                installed: { versionName: app.versionName, versionCode: app.versionCode },
                verdict: match.verdict,
                signature: match.signature,
                signatureSha256: app.signatureSha256,
                supportedVersions: match.supportedVersions,
                recommendedVersion: match.recommendedVersion,
                universalPatches: match.universalPatches.map((p) => p.patch.name),
                bundles: match.bundles.map((b) => ({
                  repo: b.bundle.repo,
                  source: b.bundle.sourceId,
                  verdict: b.verdict,
                  usable: b.usablePatches.map((p) => p.patch.name),
                  blocked: b.patchesForPackage
                    .filter((p) => !b.usablePatches.includes(p))
                    .map((p) => ({ name: p.patch.name, verdict: p.verdict })),
                  versions: b.supportedVersions,
                  versionCodes: b.supportedVersionCodes,
                })),
              },
              null,
              2,
            )}
          </pre>
        )}
        <button type="button" onClick={onShowLog} className="md-body-small mt-3 text-primary">
          Open the diagnostics log →
        </button>
      </div>

      <div className="h-6" />
    </BottomSheet>
  );
}

/**
 * One source's contribution to this app.
 *
 * Patches that do not fit the installed version are shown rather than hidden —
 * "the source has 20 patches, 3 fit your build" is the information that tells a
 * user whether upgrading or downgrading is worth it.
 */
function BundleCard({
  match,
  onNotify,
}: {
  match: import('@/core/compatibility').BundleMatch;
  onNotify: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const usableNames = new Set(match.usablePatches.map((p) => p.patch.id));
  const blocked = match.patchesForPackage.filter((p) => !usableNames.has(p.patch.id));

  return (
    <Card variant="outlined" className="mx-6 mb-2 overflow-hidden p-0">
      <ListItem
        onClick={() => setExpanded((open) => !open)}
        leading={
          match.bundle.avatarUrl ? (
            <img
              src={match.bundle.avatarUrl}
              alt=""
              width={40}
              height={40}
              className="size-10 flex-none rounded-md bg-surface-container-high object-cover"
              loading="lazy"
            />
          ) : (
            <div className="grid size-10 flex-none place-items-center rounded-md bg-tertiary-container text-on-tertiary-container">
              <Icon name="source" size={20} />
            </div>
          )
        }
        headline={match.bundle.name}
        supporting={
          <span className="flex flex-wrap items-center gap-x-2">
            <span className="md-body-small">{match.bundle.repo}</span>
            {match.bundle.stars > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Icon name="star" size={12} />
                {match.bundle.stars}
              </span>
            )}
          </span>
        }
        trailing={
          <div className="flex flex-none items-center gap-2">
            <VerdictBadge verdict={match.verdict} count={match.usablePatches.length} />
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={20} />
          </div>
        }
      />

      {expanded && (
        <div className="px-4 pb-4">
          {match.bundle.repoDescription && (
            <p className="md-body-small mb-3 text-on-surface-variant">{match.bundle.repoDescription}</p>
          )}

          {match.usablePatches.length > 0 && (
            <>
              <p className="md-label-large mb-1 text-on-surface">Applies to your build</p>
              {match.usablePatches.map((patchMatch) => (
                <PatchRow key={patchMatch.patch.id} match={patchMatch} />
              ))}
            </>
          )}

          {blocked.length > 0 && (
            <>
              <p className="md-label-large mb-1 mt-3 text-on-surface-variant">
                Declared for other versions
              </p>
              {blocked.map((patchMatch) => (
                <PatchRow key={patchMatch.patch.id} match={patchMatch} muted />
              ))}
            </>
          )}

          {match.supportedVersions.length > 0 && (
            <p className="md-body-small mt-3 break-words text-on-surface-variant">
              Covers: {match.supportedVersions.slice(-16).join(', ')}
              {match.supportedVersions.length > 16 ? ' …' : ''}
            </p>
          )}

          {!isBuiltIn(match) && match.bundle.repo && (
            <button
              type="button"
              onClick={async () => {
                const outcome = await addRepoToMorphe(match.bundle.repo);
                onNotify(outcome.message);
              }}
              className="md-label-large mt-3 flex items-center gap-1 text-primary"
            >
              <Icon name="add" size={16} />
              Add this source to Morphe
            </button>
          )}

          {match.bundle.changelogUrl && (
            <a
              href={match.bundle.changelogUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="md-body-small mt-2 inline-flex items-center gap-1 text-primary"
            >
              Changelog
              <Icon name="open-in-new" size={14} />
            </a>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Verdict to card fill.
 *
 * A map rather than a chain of `&&` conditions because the previous version
 * emitted several background utilities at once and let Tailwind's stylesheet
 * order pick the winner.
 */
const VERDICT_TONE: Record<Verdict, CardTone> = {
  supported: 'ok',
  experimental: 'warn',
  unlisted: 'tertiary',
  'too-new': 'error',
  'too-old': 'error',
  'no-patches': 'surface',
};

function PatchRow({ match, muted = false }: { match: PatchMatch; muted?: boolean }) {
  const presentation = VERDICT_PRESENTATION[match.verdict as Verdict];

  return (
    <div className={cx('flex items-start gap-3 py-2', muted && 'opacity-60')}>
      <Icon
        name={presentation.icon}
        size={16}
        className={cx('mt-0.5 flex-none', muted ? 'text-on-surface-variant' : 'text-primary')}
      />
      <div className="min-w-0 flex-1">
        <p className="md-body-medium text-on-surface">
          {match.patch.name}
          {match.patch.default === false && (
            <span className="md-label-small ml-2 rounded-xs bg-surface-container-highest px-1 text-on-surface-variant">
              off by default
            </span>
          )}
        </p>
        {match.patch.description && (
          <p className="md-body-small mt-0.5 line-clamp-3 text-on-surface-variant">
            {match.patch.description}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {match.matchedByVersionCode && (
            <Badge tone="ok">
              <Icon name="check" size={12} />
              matched by version code
            </Badge>
          )}
          {match.patch.options.length > 0 && (
            <Badge tone="neutral">
              <Icon name="tune" size={12} />
              {match.patch.options.length} option{match.patch.options.length === 1 ? '' : 's'}
            </Badge>
          )}
          {match.patch.universal && <Badge tone="tertiary">universal</Badge>}
        </div>
      </div>
    </div>
  );
}
