import { useMemo, useState } from 'react';
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
} from '@/ui/primitives';
import { AppIcon, VERDICT_PRESENTATION, VerdictBadge } from '@/ui/indicators';

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
export function AppsScreen() {
  const {
    filteredMatches,
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
  } = useStore();

  const [selected, setSelected] = useState<AppMatch | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

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

      {filteredMatches.length === 0 ? (
        <EmptyState
          icon={filters.query ? 'search' : 'apps'}
          title={filters.query ? 'No matches' : 'Nothing to show'}
          body={
            filters.query
              ? `No installed app matches “${filters.query}”.`
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
                {filteredMatches.length} app{filteredMatches.length === 1 ? '' : 's'}
              </span>
            }
          >
            {filters.patchableOnly ? 'Patchable apps' : 'All installed apps'}
          </SectionHeader>

          <Card variant="outlined" className="mx-4 overflow-hidden p-0">
            {filteredMatches.map((match, index) => (
              <div key={match.app.packageName}>
                {index > 0 && <Divider inset />}
                <AppRow match={match} onClick={() => setSelected(match)} />
              </div>
            ))}
          </Card>

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
