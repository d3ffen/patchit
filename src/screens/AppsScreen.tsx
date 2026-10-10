import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppMatch } from '@/core/compatibility';
import { useStore } from '@/state/store';
import { AppDetail } from '@/screens/AppDetail';
import { Icon } from '@/ui/icons';
import { ActivityBar, Scaffold, SectionHeader, TopAppBar } from '@/ui/layout';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  Fab,
  IconButton,
  ListItem,
  SearchBar,
  Segmented,
  Switch,
  useSnackbar,
} from '@/ui/primitives';
import { AppIcon, VERDICT_PRESENTATION, VerdictBadge } from '@/ui/indicators';
import { UpdateSheet } from '@/ui/updater';
import type { BrowseEntry } from '@/state/store';
import type { RegistryPackage } from '@/core/compatibility';
import { addRepoToMorphe } from '@/core/morphe';

/**
 * The main list: every installed app, with its patchability decided.
 *
 * One interaction, deliberately: tapping a row opens a sheet with the full
 * breakdown. There is no multi-select and no bulk action, because the only
 * actions available are read-only inspection and "add the sources covering this
 * app to Morphe" — and that second one is per-app by nature, since the answer
 * differs per app.
 *
 * The list itself is derived in `filteredMatches`; this component only renders.
 * Filtering 300 rows during a render pass is exactly how a list like this
 * becomes janky on a mid-range device.
 */
/**
 * How many rows are mounted at once.
 *
 * A phone cannot usefully render a thousand list rows, and trying means a long
 * stall on the main thread followed by a very large DOM. Pages of 60 keep the
 * first paint quick; the sentinel below grows the window as the list is
 * scrolled, so it behaves like an endless list without ever holding all of it.
 */
const PAGE_SIZE = 60;

/**
 * Grows the list when the end of it comes into view, with a button as backup.
 *
 * The button is not decoration: the observer can miss when the list is inside a
 * container that has not settled yet, and a list that silently stops loading is
 * worse than one that needs a tap.
 */
function LoadMore({ remaining, onLoadMore }: { remaining: number; onLoadMore: () => void }) {
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore]);

  return (
    <div ref={sentinel} className="mt-4 flex flex-col items-center gap-2 px-4">
      <p className="md-body-small text-on-surface-variant">{remaining} more</p>
      <Button variant="tonal" icon="chevron-down" onClick={onLoadMore}>
        Load more
      </Button>
    </div>
  );
}

export function AppsScreen() {
  const {
    matches,
    filters,
    setFilters,
    sync,
    rescan,
    syncing,
    scanning,
    syncProgress,
    scanMeta,
    lastSyncAt,
    morpheInstalls,
    snapshot,
    error,
    setLogsOpen,
    update,
    recheckUpdate,
    browseEntries,
  } = useStore();

  const [selected, setSelected] = useState<AppMatch | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [registryPackage, setRegistryPackage] = useState<RegistryPackage | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // A new query, mode or sort is a different list — start it from the top again
  // rather than leaving the window scrolled deep into results nobody has seen.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [filters.browseMode, filters.query, filters.sort]);

  const patchable = useMemo(() => matches.filter((m) => m.verdict !== 'no-patches').length, [matches]);
  const verified = useMemo(() => matches.filter((m) => m.verdict === 'supported').length, [matches]);
  const needingAttention = useMemo(
    () => matches.filter((m) => m.verdict === 'too-new' || m.verdict === 'too-old').length,
    [matches],
  );

  const activeFilterCount =
    (filters.patchableOnly ? 1 : 0) +
    (filters.includeSystem ? 1 : 0) +
    (filters.includeSplits ? 0 : 1);

  const subtitle = syncing
    ? syncProgress?.message ?? 'Syncing registry…'
    : scanning
      ? 'Scanning packages…'
      : `${patchable} patchable · ${verified} verified${needingAttention ? ` · ${needingAttention} need attention` : ''}`;

  return (
    <Scaffold
      appBar={
        <>
          <TopAppBar
            title="PatchIt"
            subtitle={subtitle}
            actions={
              <>
                <IconButton
                  icon="filter-list"
                  label="Filters"
                  selected={activeFilterCount > 0}
                  onClick={() => setFiltersOpen(true)}
                />
                <IconButton
                  icon="sync"
                  label="Sync registry"
                  disabled={syncing}
                  onClick={() => void sync({ force: true })}
                />
              </>
            }
            search={
              <SearchBar
                placeholder="Search apps or packages"
                value={filters.query}
                onChange={(query) => setFilters({ query })}
                trailing={
                  filters.query ? (
                    <IconButton
                      icon="close"
                      label="Clear search"
                      size={24}
                      onClick={() => setFilters({ query: '' })}
                    />
                  ) : undefined
                }
              />
            }
          />
          <div className="px-4 pb-2">
            <Segmented
              value={filters.browseMode}
              onChange={(browseMode) => setFilters({ browseMode })}
              options={[
                { value: 'installed', label: 'Installed' },
                { value: 'all', label: 'All apps' },
              ]}
            />
          </div>
          {(syncing || scanning) && (
            <ActivityBar
              label={
                syncing
                  ? syncProgress
                    ? `${syncProgress.message ?? 'Syncing'} (${syncProgress.completed}/${syncProgress.total})`
                    : 'Syncing registry…'
                  : 'Scanning installed packages…'
              }
            />
          )}
        </>
      }
      fab={<Fab icon="refresh" label="Rescan packages" onClick={() => void rescan()} />}
    >
      {update.kind === 'available' && (
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={() => setUpdateOpen(true)}
            className="state-layer flex w-full items-center gap-3 rounded-md bg-primary-container px-4 py-3 text-left text-on-primary-container"
          >
            <Icon name="update" size={20} className="flex-none" />
            <span className="md-body-medium flex-1">
              PatchIt {update.release.version} is available.
            </span>
            <Icon name="chevron-right" size={20} className="flex-none" />
          </button>
        </div>
      )}

      {error && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-md bg-error-container px-4 py-3 text-on-error-container">
          <Icon name="warning" size={20} className="mt-0.5 flex-none" />
          <p className="md-body-medium flex-1">{error}</p>
        </div>
      )}

      {scanMeta && !scanMeta.fullVisibility && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-md bg-warn-container px-4 py-3 text-on-warn-container">
          <Icon name="visibility-off" size={20} className="mt-0.5 flex-none" />
          <p className="md-body-medium flex-1">
            Android only returned {scanMeta.skipped} visible packages. Grant the package-visibility
            permission so the scan can see every installed app.
          </p>
        </div>
      )}

      {morpheInstalls.length === 0 && snapshot && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-md bg-surface-container-high px-4 py-3">
          <Icon name="info" size={20} className="mt-0.5 flex-none text-on-surface-variant" />
          <p className="md-body-medium flex-1 text-on-surface-variant">
            Morphe Manager was not found on this device. You can still scan and compare, but there
            is nowhere to add the sources covering your apps.
          </p>
        </div>
      )}

      {browseEntries.length === 0 ? (
        <EmptyState
          icon={filters.query ? 'search' : 'apps'}
          title={filters.query ? 'No matches' : 'Nothing to show'}
          body={
            filters.query
              ? filters.browseMode === 'all'
                ? `Nothing in the registry matches “${filters.query}”.`
                : `No installed app matches “${filters.query}”. Switch to All apps to search the whole registry.`
              : filters.patchableOnly
                ? 'No installed app has patches in the current registry. Try enabling system apps, or add a patch source.'
                : 'Hit rescan to enumerate installed packages.'
          }
          action={
            filters.patchableOnly ? (
              <Button variant="tonal" icon="tune" onClick={() => setFilters({ patchableOnly: false })}>
                Show all apps
              </Button>
            ) : (
              <Button variant="tonal" icon="refresh" onClick={() => void rescan()}>
                Rescan
              </Button>
            )
          }
        />
      ) : (
        <>
          <SectionHeader
            trailing={
              <span className="md-label-medium text-on-surface-variant">
                {browseEntries.length}{' '}
                {filters.browseMode === 'all'
                  ? browseEntries.length === 1
                    ? 'package'
                    : 'packages'
                  : browseEntries.length === 1
                    ? 'app'
                    : 'apps'}
              </span>
            }
          >
            {filters.browseMode === 'all'
              ? 'Installed and available'
              : filters.patchableOnly
                ? 'Patchable apps'
                : 'All installed apps'}
          </SectionHeader>

          <Card variant="outlined" className="mx-4 overflow-hidden p-0">
            {browseEntries.slice(0, visibleCount).map((entry, index) => (
              <div key={entry.packageName}>
                {index > 0 && <Divider inset />}
                {entry.kind === 'installed' ? (
                  <AppRow match={entry.match} onClick={() => setSelected(entry.match)} />
                ) : (
                  <RegistryRow entry={entry} onClick={() => setRegistryPackage(entry.info)} />
                )}
              </div>
            ))}
          </Card>

          {visibleCount < browseEntries.length && (
            <LoadMore
              remaining={browseEntries.length - visibleCount}
              onLoadMore={() => setVisibleCount((count) => count + PAGE_SIZE)}
            />
          )}

          <div className="mt-6 px-4">
            <p className="md-body-small text-on-surface-variant">
              {lastSyncAt
                ? `Registry synced ${new Date(lastSyncAt).toLocaleString()}`
                : 'Registry not synced yet'}
              {snapshot ? ` · ${snapshot.bundles.length} bundles` : ''}
            </p>
          </div>
        </>
      )}

      <RegistryDetail info={registryPackage} onClose={() => setRegistryPackage(null)} />

      <AppDetail
        match={selected}
        onClose={() => setSelected(null)}
        onShowLog={() => {
          // Dismiss the sheet first: the viewer is a full-screen overlay and
          // stacking it over a sheet leaves the user with two back gestures.
          setSelected(null);
          setLogsOpen(true);
        }}
      />

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        activeFilterCount={activeFilterCount}
      />

      {update.kind === 'available' && (
        <UpdateSheet
          open={updateOpen}
          onClose={() => {
            setUpdateOpen(false);
            // After a successful install this build keeps running until Android
            // restarts it, so re-check rather than keep offering the same one.
            recheckUpdate();
          }}
          release={update.release}
          currentVersionLabel={update.current}
        />
      )}
    </Scaffold>
  );
}

function AppRow({ match, onClick }: { match: AppMatch; onClick: () => void }) {
  const presentation = VERDICT_PRESENTATION[match.verdict];

  return (
    <ListItem
      onClick={onClick}
      leading={<AppIcon packageName={match.app.packageName} label={match.app.label} size={48} />}
      headline={
        <span className="flex items-center gap-2">
          {match.app.label}
          {match.app.isSystem && !match.app.isUpdatedSystemApp && (
            <Icon name="memory" size={14} className="flex-none text-on-surface-variant" />
          )}
          {match.app.hasSplits && (
            <span className="md-label-small rounded-xs bg-surface-container-highest px-1 text-on-surface-variant">
              split
            </span>
          )}
        </span>
      }
      supporting={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="md-body-small">{match.app.packageName}</span>
          <span className="text-outline">·</span>
          <span>{match.app.versionName || `code ${match.app.versionCode}`}</span>
        </span>
      }
      trailing={
        <div className="flex flex-none items-center gap-2">
          <div className="hidden sm:block">
            <VerdictBadge verdict={match.verdict} />
          </div>
          <div className="sm:hidden">
            <Badge tone={presentation.tone}>
              <Icon name={presentation.icon} size={14} />
              {match.usablePatchCount || ''}
            </Badge>
          </div>
          <Icon name="chevron-right" size={20} className="text-on-surface-variant" />
        </div>
      }
    />
  );
}

function FilterSheet({
  open,
  onClose,
  activeFilterCount,
}: {
  open: boolean;
  onClose: () => void;
  activeFilterCount: number;
}) {
  const { filters, setFilters } = useStore();

  return (
    <BottomSheet open={open} onClose={onClose} title="Filters">
      <div className="px-6 pb-2">
        <div className="flex flex-col gap-1">
          <ToggleRow
            label="Only apps with patches"
            description="Hide everything the registry has nothing for."
            checked={filters.patchableOnly}
            onChange={(patchableOnly) => setFilters({ patchableOnly })}
          />
          <ToggleRow
            label="Include system apps"
            description="Most system apps cannot be patched, but updated ones can."
            checked={filters.includeSystem}
            onChange={(includeSystem) => setFilters({ includeSystem })}
          />
          <ToggleRow
            label="Include split installs"
            description="Apps installed from an app bundle. Morphe needs every split APK."
            checked={filters.includeSplits}
            onChange={(includeSplits) => setFilters({ includeSplits })}
          />
        </div>

        <div className="mt-6">
          <p className="md-title-small mb-2 text-on-surface">Sort by</p>
          <Segmented
            value={filters.sort}
            onChange={(sort) => setFilters({ sort })}
            options={[
              { value: 'name', label: 'Name' },
              { value: 'verdict', label: 'Status' },
              { value: 'patches', label: 'Patches' },
            ]}
          />
        </div>

        <div className="mt-6">
          <p className="md-title-small mb-2 text-on-surface">Quick filters</p>
          <div className="flex flex-wrap gap-2">
            <Chip
              icon="verified"
              selected={false}
              checkOnSelect={false}
              onClick={() => setFilters({ patchableOnly: true, sort: 'verdict' })}
            >
              Verified only
            </Chip>
            <Chip
              icon="update"
              selected={false}
              checkOnSelect={false}
              onClick={() => setFilters({ patchableOnly: true, sort: 'verdict', query: '' })}
            >
              Needs attention
            </Chip>
            <Chip
              icon="tune"
              selected={false}
              checkOnSelect={false}
              onClick={() =>
                setFilters({ patchableOnly: true, includeSystem: false, includeSplits: true, sort: 'name' })
              }
            >
              Reset {activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
            </Chip>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <Button variant="filled" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="md-body-large text-on-surface">{label}</p>
        <p className="md-body-medium text-on-surface-variant">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Registry-only rows
 * ------------------------------------------------------------------ */

/**
 * A package the registry covers that is not installed here.
 *
 * There is no build to judge, so there is no verdict to show — inventing one
 * would be the false-confidence this app exists to avoid. What it can honestly
 * say is what is on offer: how many patches, and which builds they name.
 */
function RegistryRow({
  entry,
  onClick,
}: {
  entry: Extract<BrowseEntry, { kind: 'registry' }>;
  onClick: () => void;
}) {
  const { info } = entry;

  return (
    <button
      type="button"
      onClick={onClick}
      className="md-list-item state-layer flex w-full items-center gap-4 px-4 py-3 text-left"
    >
      <AppIcon packageName={info.packageName} label={entry.label} size={48} />

      <div className="min-w-0 flex-1">
        <p className="md-body-large truncate text-on-surface">{entry.label}</p>
        <p className="md-body-medium truncate text-on-surface-variant">
          {info.packageName}
        </p>
        <p className="md-body-small mt-0.5 truncate text-on-surface-variant">
          {info.newestVersion ? `Newest supported ${info.newestVersion}` : 'No versions declared'}
        </p>
      </div>

      <div className="flex flex-none items-center gap-2">
        <Badge tone="neutral">
          <Icon name="extension" size={14} />
          {info.patchCount}
        </Badge>
        <Icon name="chevron-right" size={20} className="text-on-surface-variant" />
      </div>
    </button>
  );
}

/**
 * The detail sheet for a package that is not installed.
 *
 * Mirrors the installed-app sheet where it can — same version chips, same source
 * rows — but the header says plainly that the app is not here, because every
 * "does this work for me?" question below it is unanswerable until it is.
 */
function RegistryDetail({
  info,
  onClose,
}: {
  info: RegistryPackage | null;
  onClose: () => void;
}) {
  const { show } = useSnackbar();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(info !== null);
  }, [info]);

  if (!info) return null;

  const label = info.name ?? info.packageName;

  return (
    <BottomSheet open={open} onClose={onClose} title={label}>
      <div className="px-6 pb-6">
        <div className="flex items-center gap-4">
          <AppIcon packageName={info.packageName} label={label} size={56} />
          <div className="min-w-0 flex-1">
            <p className="md-title-large truncate text-on-surface">{label}</p>
            <p className="md-body-medium truncate text-on-surface-variant">{info.packageName}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="neutral">
            <Icon name="download" size={14} />
            Not installed
          </Badge>
          <Badge tone="primary">
            <Icon name="extension" size={14} />
            {info.patchCount} patch{info.patchCount === 1 ? '' : 'es'}
          </Badge>
          <Badge tone="neutral">
            <Icon name="source" size={14} />
            {info.bundleCount} source{info.bundleCount === 1 ? '' : 's'}
          </Badge>
        </div>

        <p className="md-body-medium mt-4 text-on-surface-variant">
          This app is not on your device, so PatchIt cannot check whether your build is
          supported. Install it, then rescan to get a verdict.
        </p>

        {info.supportedVersions.length > 0 && (
          <>
            <p className="md-title-small mt-5 text-on-surface">Supported versions</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {info.supportedVersions.slice(0, 12).map((version) => (
                <Chip key={version}>{version}</Chip>
              ))}
              {info.supportedVersions.length > 12 && (
                <Chip>+{info.supportedVersions.length - 12} more</Chip>
              )}
            </div>
          </>
        )}

        <p className="md-title-small mt-5 text-on-surface">
          Source{info.repos.length === 1 ? '' : 's'}
        </p>
        <div className="mt-2 space-y-2">
          {info.repos.map((repo) => (
            <Card key={repo} variant="outlined" className="flex items-center gap-3 p-3">
              <Icon name="source" size={20} className="flex-none text-on-surface-variant" />
              <span className="md-body-medium min-w-0 flex-1 truncate text-on-surface">{repo}</span>
              <Button
                variant="text"
                icon="add"
                onClick={() => {
                  addRepoToMorphe(repo).then((result) => {
                    if (!result.ok) show({ message: result.message });
                  });
                }}
              >
                Add
              </Button>
            </Card>
          ))}
        </div>

        <div className="mt-5 flex justify-end">
          <Button variant="text" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
