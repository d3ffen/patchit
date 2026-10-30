import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { AppMatch, RegistryPackage, Verdict } from '@/core/compatibility';
import { STORE_CATEGORIES } from '@/registry/schema';
import { useStore, type BrowseEntry, type Filters } from '@/state/store';
import { AppDetail } from '@/screens/AppDetail';
import { Icon } from '@/ui/icons';
import { ActivityBar, Scaffold, SectionHeader, TopAppBar } from '@/ui/layout';
import {
  Badge,
  BottomSheet,
  Button,
  Chip,
  EmptyState,
  Fab,
  IconButton,
  SearchBar,
  Segmented,
  Switch,
  cx,
  useSnackbar,
} from '@/ui/primitives';
import { AppIcon, VERDICT_PRESENTATION } from '@/ui/indicators';
import { UpdateSheet } from '@/ui/updater';
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
 * The list itself is derived in `browseEntries`; this component only renders.
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

/* ------------------------------------------------------------------ *
 * Filter vocabulary
 * ------------------------------------------------------------------ */

const STATUS_OPTIONS: { value: Filters['status']; label: string; description: string }[] = [
  { value: 'all', label: 'All statuses', description: 'Every app, whatever its verdict.' },
  { value: 'supported', label: 'Supported', description: 'A source covers this exact build.' },
  {
    value: 'experimental',
    label: 'Experimental',
    description: 'Patches exist, but the source marks them experimental.',
  },
  {
    value: 'unlisted',
    label: 'Untested',
    description: 'The source declares no versions, so nothing is verified.',
  },
  {
    value: 'mismatch',
    label: 'Needs another build',
    description: 'Too new or too old for every patch that covers it.',
  },
  { value: 'none', label: 'No patches', description: 'Nothing in the registry covers this app.' },
];

const STATUS_LABEL = new Map(STATUS_OPTIONS.map((option) => [option.value, option.label]));

const VERDICT_DOT: Record<Verdict, string> = {
  supported: '#4ade80',
  experimental: '#fbbf24',
  unlisted: '#93c5fd',
  'too-new': '#f87171',
  'too-old': '#f87171',
  'no-patches': '#9ca3af',
};

function hueFor(packageName: string): number {
  let hash = 0;
  for (let index = 0; index < packageName.length; index += 1) {
    hash = (hash * 31 + packageName.charCodeAt(index)) % 360;
  }
  return hash;
}

function tileStyle(packageName: string): CSSProperties {
  return { '--tile-hue': hueFor(packageName) } as CSSProperties;
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

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
    hidden,
    patched,
    hiddenCount,
    patchedCount,
    toggleHidden,
    setPatched,
  } = useStore();
  const { show } = useSnackbar();

  const [selected, setSelected] = useState<AppMatch | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [picker, setPicker] = useState<'status' | 'category' | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [registryPackage, setRegistryPackage] = useState<RegistryPackage | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // A new query, mode or filter is a different list — start it from the top
  // rather than leaving the window scrolled deep into results nobody has seen.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [
    filters.browseMode,
    filters.query,
    filters.sort,
    filters.status,
    filters.category,
    filters.patched,
    filters.showHidden,
  ]);

  const visibleMatches = useMemo(
    () => matches.filter((match) => !hidden.has(match.app.packageName)),
    [matches, hidden],
  );
  const patchable = useMemo(
    () => visibleMatches.filter((match) => match.verdict !== 'no-patches').length,
    [visibleMatches],
  );
  const verified = useMemo(
    () => visibleMatches.filter((match) => match.verdict === 'supported').length,
    [visibleMatches],
  );
  const needingAttention = useMemo(
    () =>
      visibleMatches.filter(
        (match) => match.verdict === 'too-new' || match.verdict === 'too-old',
      ).length,
    [visibleMatches],
  );

  /**
   * The categories actually present in the registry, in the community site's
   * order. Built from the store map rather than a hardcoded list so a category
   * that disappears from the crawl disappears from the filter too.
   */
  const categories = useMemo(() => {
    const found = new Set<string>();
    for (const entry of Object.values(snapshot?.store ?? {})) {
      if (entry.category) found.add(entry.category);
    }
    const ordered = STORE_CATEGORIES.filter((category) => found.has(category));
    const extra = [...found]
      .filter((category) => !(STORE_CATEGORIES as readonly string[]).includes(category))
      .sort((a, b) => a.localeCompare(b));
    return [...ordered, ...extra];
  }, [snapshot]);

  const categoryOptions = useMemo(
    () => [
      { value: 'all', label: 'All categories', description: 'The whole registry.' },
      ...categories.map((category) => ({ value: category, label: category })),
      {
        value: 'Other',
        label: 'Other',
        description: 'Packages the community store has not categorised.',
      },
    ],
    [categories],
  );

  const activeFilterCount =
    (filters.status !== 'all' ? 1 : 0) +
    (filters.category !== 'all' ? 1 : 0) +
    (filters.patched !== 'all' ? 1 : 0) +
    (filters.showHidden ? 1 : 0) +
    (filters.patchableOnly ? 0 : 1) +
    (filters.includeSystem ? 1 : 0) +
    (filters.includeSplits ? 0 : 1);

  const subtitle = syncing
    ? syncProgress?.message ?? 'Syncing registry…'
    : scanning
      ? 'Scanning packages…'
      : [
          `${patchable} patchable`,
          verified ? `${verified} verified` : '',
          patchedCount ? `${patchedCount} patched` : '',
          needingAttention ? `${needingAttention} to fix` : '',
        ]
          .filter(Boolean)
          .join(' · ');

  const sectionTitle =
    filters.category !== 'all'
      ? filters.category
      : filters.browseMode === 'all'
        ? 'Installed and available'
        : filters.patchableOnly
          ? 'Patchable apps'
          : 'All installed apps';

  const filtersAreActive =
    filters.query !== '' ||
    filters.status !== 'all' ||
    filters.category !== 'all' ||
    filters.patched !== 'all' ||
    filters.showHidden ||
    !filters.patchableOnly ||
    filters.includeSystem ||
    !filters.includeSplits;

  const clearFilters = () =>
    setFilters({
      query: '',
      patchableOnly: true,
      includeSystem: false,
      includeSplits: true,
      status: 'all',
      category: 'all',
      patched: 'all',
      showHidden: false,
    });

  const labelOf = (entry: BrowseEntry) =>
    entry.kind === 'installed' ? entry.match.app.label : entry.label;

  const onToggleHidden = (entry: BrowseEntry) => {
    const willHide = !hidden.has(entry.packageName);
    toggleHidden(entry.packageName);
    show({
      message: willHide ? `${labelOf(entry)} hidden` : `${labelOf(entry)} back in the list`,
      action: {
        label: 'Undo',
        run: () => toggleHidden(entry.packageName),
      },
    });
  };

  const onTogglePatched = (entry: BrowseEntry) => {
    const marked = Boolean(patched[entry.packageName]);
    setPatched(
      entry.packageName,
      !marked,
      entry.kind === 'installed'
        ? {
            versionName: entry.match.app.versionName,
            versionCode: entry.match.app.versionCode,
          }
        : undefined,
    );
    show({
      message: marked
        ? `${labelOf(entry)} is no longer marked as patched`
        : `${labelOf(entry)} marked as patched`,
    });
  };

  return (
    <Scaffold
      appBar={
        <>
          <TopAppBar
            title={<span className="wordmark">PatchIt</span>}
            subtitle={subtitle}
            actions={
              <>
                <IconButton
                  icon="filter-list"
                  label="Filters"
                  variant="tonal"
                  selected={activeFilterCount > 0}
                  onClick={() => setFiltersOpen(true)}
                />
                <IconButton
                  icon="sync"
                  label="Sync registry"
                  variant="tonal"
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

          {/* The filter row mirrors the community site: category + status
              dropdowns, then the two states that only exist on this device. */}
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-1">
            <FilterPill
              icon="tune"
              label={filters.status === 'all' ? 'Status' : STATUS_LABEL.get(filters.status) ?? 'Status'}
              active={filters.status !== 'all'}
              onClick={() => setPicker('status')}
            />
            <FilterPill
              icon="apps"
              label={filters.category === 'all' ? 'Category' : filters.category}
              active={filters.category !== 'all'}
              onClick={() => setPicker('category')}
            />
            <span className="hidden h-5 w-px flex-none bg-outline-variant sm:block" aria-hidden="true" />
            <Chip
              icon="check-circle"
              selected={filters.patched === 'patched'}
              checkOnSelect={false}
              onClick={() =>
                setFilters({ patched: filters.patched === 'patched' ? 'all' : 'patched' })
              }
            >
              Patched{patchedCount ? ` · ${patchedCount}` : ''}
            </Chip>
            <Chip
              icon={filters.showHidden ? 'visibility' : 'visibility-off'}
              selected={filters.showHidden}
              checkOnSelect={false}
              onClick={() => setFilters({ showHidden: !filters.showHidden })}
            >
              Hidden{hiddenCount ? ` · ${hiddenCount}` : ''}
            </Chip>
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
            className="state-layer flex w-full items-center gap-3 rounded-[24px] bg-primary-container px-4 py-3 text-left text-on-primary-container"
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
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-[20px] bg-error-container px-4 py-3 text-on-error-container">
          <Icon name="warning" size={20} className="mt-0.5 flex-none" />
          <p className="md-body-medium flex-1">{error}</p>
        </div>
      )}

      {scanMeta && !scanMeta.fullVisibility && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-[20px] bg-warn-container px-4 py-3 text-on-warn-container">
          <Icon name="visibility-off" size={20} className="mt-0.5 flex-none" />
          <p className="md-body-medium flex-1">
            Android only returned {scanMeta.skipped} visible packages. Grant the package-visibility
            permission so the scan can see every installed app.
          </p>
        </div>
      )}

      {morpheInstalls.length === 0 && snapshot && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-[20px] bg-surface-container-high px-4 py-3">
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
              : filtersAreActive
                ? 'No app matches the filters you picked. Clear them to see the full list.'
                : 'Hit rescan to enumerate installed packages.'
          }
          action={
            filtersAreActive ? (
              <Button variant="tonal" icon="tune" onClick={clearFilters}>
                Clear filters
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
              <span className="md-label-medium rounded-full bg-surface-container-high px-2.5 py-1 text-on-surface-variant">
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
            {sectionTitle}
          </SectionHeader>

          <div className="flex flex-col gap-2 px-4">
            {browseEntries.slice(0, visibleCount).map((entry, index) => {
              const marked = Boolean(patched[entry.packageName]);
              const isHidden = hidden.has(entry.packageName);
              return (
                <SwipeRow
                  key={entry.packageName}
                  index={index}
                  marked={marked}
                  hidden={isHidden}
                  onToggleMarked={() => onTogglePatched(entry)}
                  onToggleHidden={() => onToggleHidden(entry)}
                >
                  {entry.kind === 'installed' ? (
                    <AppRow
                      match={entry.match}
                      marked={marked}
                      hidden={isHidden}
                      onClick={() => setSelected(entry.match)}
                    />
                  ) : (
                    <RegistryRow
                      entry={entry}
                      marked={marked}
                      hidden={isHidden}
                      onClick={() => setRegistryPackage(entry.info)}
                    />
                  )}
                </SwipeRow>
              );
            })}
          </div>

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

      <PickerSheet
        open={picker === 'status'}
        onClose={() => setPicker(null)}
        title="Status"
        options={STATUS_OPTIONS}
        value={filters.status}
        onSelect={(status) => {
          const next = status as Filters['status'];
          // "No patches" and "only apps with patches" are mutually exclusive;
          // picking the former while the latter is on would always be empty.
          setFilters(next === 'none' ? { status: next, patchableOnly: false } : { status: next });
        }}
      />
      <PickerSheet
        open={picker === 'category'}
        onClose={() => setPicker(null)}
        title="Category"
        options={categoryOptions}
        value={filters.category}
        onSelect={(category) => setFilters({ category })}
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

/* ------------------------------------------------------------------ *
 * Swipeable row
 * ------------------------------------------------------------------ */

/**
 * Morphe Manager's app cards swipe in both directions: one side marks the build
 * as patched, the other hides it. Hiding is destructive to the *view*, not the
 * data, so it gets the error colour and an undo snackbar; marking is positive
 * and gets the success colour.
 *
 * Pointer events with `touch-action: pan-y` are the important part: a vertical
 * drag must stay a scroll, so the gesture is only claimed once it is clearly
 * horizontal. A click that follows a completed swipe is swallowed, otherwise
 * flicking a row would also open its detail sheet.
 */
function SwipeRow({
  marked,
  hidden,
  index,
  onToggleMarked,
  onToggleHidden,
  children,
}: {
  marked: boolean;
  hidden: boolean;
  /** Row position, used only to stagger the entrance animation. */
  index: number;
  onToggleMarked: () => void;
  onToggleHidden: () => void;
  children: ReactNode;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const offsetRef = useRef(0);
  const drag = useRef<{ x: number; y: number; decided: boolean } | null>(null);
  const suppressClick = useRef(false);

  const apply = (value: number) => {
    offsetRef.current = value;
    setOffset(value);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, decided: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;

    const deltaX = event.clientX - state.x;
    const deltaY = event.clientY - state.y;

    if (!state.decided) {
      // Vertical intent wins: release the gesture to the scroller.
      if (Math.abs(deltaY) > 10 && Math.abs(deltaY) >= Math.abs(deltaX)) {
        drag.current = null;
        return;
      }
      if (Math.abs(deltaX) > 10) {
        state.decided = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      } else {
        return;
      }
    }

    apply(Math.max(-120, Math.min(120, deltaX)));
  };

  const settle = () => {
    const state = drag.current;
    const value = offsetRef.current;
    drag.current = null;

    if (state?.decided && Math.abs(value) > 64) {
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 350);
      if (value > 0) onToggleMarked();
      else onToggleHidden();
    }

    setDragging(false);
    apply(0);
  };

  return (
    <div
      className="animate-row-in relative overflow-hidden rounded-[24px]"
      style={{
        touchAction: 'pan-y',
        animationDelay: `${Math.min(index, 9) * 32}ms`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={settle}
      onPointerCancel={settle}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div
        className="swipe-action justify-start gap-2 bg-ok-container text-on-ok-container"
        style={{ opacity: offset > 0 ? Math.min(1, offset / 70) : 0 }}
        aria-hidden="true"
      >
        <Icon name={marked ? 'undo' : 'check-circle'} size={22} />
        <span className="md-label-large">{marked ? 'Unmark' : 'Patched'}</span>
      </div>
      <div
        className="swipe-action justify-end gap-2 bg-error-container text-on-error-container"
        style={{ opacity: offset < 0 ? Math.min(1, -offset / 70) : 0 }}
        aria-hidden="true"
      >
        <span className="md-label-large">{hidden ? 'Unhide' : 'Hide'}</span>
        <Icon name={hidden ? 'visibility' : 'visibility-off'} size={22} />
      </div>

      <div
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.2, 0, 0, 1)',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Rows
 * ------------------------------------------------------------------ */

function VerdictPill({ verdict }: { verdict: Verdict }) {
  return (
    <span className="tile-chip inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold">
      <span
        className="size-1.5 flex-none rounded-full"
        style={{ backgroundColor: VERDICT_DOT[verdict] }}
      />
      {VERDICT_PRESENTATION[verdict].label}
    </span>
  );
}

function PatchedPill({ stale = false }: { stale?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ok-container px-2 py-0.5 text-[11px] font-semibold text-on-ok-container">
      <Icon name="check-circle" size={12} />
      {stale ? 'Patched · older build' : 'Patched'}
    </span>
  );
}

function HiddenPill() {
  return (
    <span className="tile-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
      <Icon name="visibility-off" size={12} />
      Hidden
    </span>
  );
}

function AppRow({
  match,
  marked,
  hidden,
  onClick,
}: {
  match: AppMatch;
  marked: boolean;
  hidden: boolean;
  onClick: () => void;
}) {
  const { patched } = useStore();
  const mark = patched[match.app.packageName];
  const stale = Boolean(
    mark &&
      mark.versionCode &&
      match.app.versionCode &&
      mark.versionCode !== match.app.versionCode,
  );

  return (
    <button
      type="button"
      onClick={onClick}
      style={tileStyle(match.app.packageName)}
      className={cx(
        'app-tile state-layer flex w-full items-center gap-3.5 rounded-[24px] px-4 py-3 text-left',
        hidden && 'opacity-60',
      )}
    >
      <AppIcon packageName={match.app.packageName} label={match.app.label} size={52} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="tile-title truncate text-[17px] font-bold leading-6 tracking-[-0.2px]">
            {match.app.label}
          </p>
          {match.app.isSystem && !match.app.isUpdatedSystemApp && (
            <Icon name="memory" size={13} className="tile-sub flex-none" />
          )}
        </div>
        <p className="tile-sub mt-0.5 truncate text-[12px] font-medium">
          {match.app.packageName} · {match.app.versionName || `code ${match.app.versionCode}`}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <VerdictPill verdict={match.verdict} />
          {marked && <PatchedPill stale={stale} />}
          {hidden && <HiddenPill />}
          {match.app.hasSplits && (
            <span className="tile-chip inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold">
              split
            </span>
          )}
        </div>
      </div>

      <Icon name="chevron-right" size={20} className="tile-chevron flex-none" />
    </button>
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
  marked,
  hidden,
  onClick,
}: {
  entry: Extract<BrowseEntry, { kind: 'registry' }>;
  marked: boolean;
  hidden: boolean;
  onClick: () => void;
}) {
  const { info } = entry;

  return (
    <button
      type="button"
      onClick={onClick}
      style={tileStyle(info.packageName)}
      className={cx(
        'app-tile state-layer flex w-full items-center gap-3.5 rounded-[24px] px-4 py-3 text-left',
        hidden && 'opacity-60',
      )}
    >
      <AppIcon packageName={info.packageName} label={entry.label} size={52} clip />

      <div className="min-w-0 flex-1">
        <p className="tile-title truncate text-[17px] font-bold leading-6 tracking-[-0.2px]">
          {entry.label}
        </p>
        <p className="tile-sub mt-0.5 truncate text-[12px] font-medium">
          {info.packageName} · {info.category ?? 'Other'}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="tile-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            <Icon name="extension" size={12} />
            {info.patchCount} patch{info.patchCount === 1 ? '' : 'es'}
          </span>
          <span className="tile-chip inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold">
            <Icon name="download" size={12} />
            Not installed
          </span>
          {marked && <PatchedPill />}
          {hidden && <HiddenPill />}
        </div>
      </div>

      <Icon name="chevron-right" size={20} className="tile-chevron flex-none" />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Filter pill + picker
 * ------------------------------------------------------------------ */

function FilterPill({
  icon,
  label,
  active,
  onClick,
}: {
  icon: 'tune' | 'apps';
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'state-layer md-label-large inline-flex h-8 flex-none items-center gap-1.5 rounded-full border px-3.5',
        active
          ? 'border-transparent bg-secondary-container text-on-secondary-container'
          : 'border-outline-variant text-on-surface-variant',
      )}
    >
      <Icon name={icon} size={16} />
      <span className="max-w-40 truncate">{label}</span>
      <Icon name="chevron-down" size={16} />
    </button>
  );
}

function PickerSheet({
  open,
  onClose,
  title,
  options,
  value,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  options: { value: string; label: string; description?: string }[];
  value: string;
  onSelect: (value: string) => void;
}) {
  /*
   * The sheet mounts under the finger that opened it. Android WebView can emit
   * a second synthetic click at the same coordinates, which lands on whichever
   * option happens to be there — on this screen that was "Education", so
   * opening the picker silently applied a category. Ignore input for the first
   * few frames; a deliberate second tap is far slower than this.
   */
  const openedAt = useRef(0);
  useEffect(() => {
    if (open) openedAt.current = Date.now();
  }, [open]);

  const choose = (value: string) => {
    if (Date.now() - openedAt.current < 320) return;
    onSelect(value);
    onClose();
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-1 px-3 pb-6">
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => choose(option.value)}
              className="state-layer flex w-full items-center gap-3 rounded-[20px] px-3 py-3 text-left"
            >
              <span
                className={cx(
                  'grid size-5 flex-none place-items-center rounded-full border',
                  selected
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-outline text-transparent',
                )}
              >
                <Icon name="check" size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="md-body-large block text-on-surface">{option.label}</span>
                {option.description && (
                  <span className="md-body-small block text-on-surface-variant">
                    {option.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </BottomSheet>
  );
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

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
          <ToggleRow
            label="Show hidden apps"
            description="Hiding removes an app from the list; it is never deleted."
            checked={filters.showHidden}
            onChange={(showHidden) => setFilters({ showHidden })}
          />
        </div>

        <div className="mt-6">
          <p className="md-title-small mb-2 text-on-surface">Patched</p>
          <Segmented
            value={filters.patched}
            onChange={(patched) => setFilters({ patched })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'patched', label: 'Patched' },
              { value: 'unpatched', label: 'Not patched' },
            ]}
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

        <div className="mt-8 flex items-center justify-between">
          <Button
            variant="text"
            icon="refresh"
            onClick={() =>
              setFilters({
                query: '',
                patchableOnly: true,
                includeSystem: false,
                includeSplits: true,
                sort: 'name',
                status: 'all',
                category: 'all',
                patched: 'all',
                showHidden: false,
              })
            }
          >
            Reset{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
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
 * Registry detail
 * ------------------------------------------------------------------ */

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
  const { hidden, patched, toggleHidden, setPatched } = useStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(info !== null);
  }, [info]);

  if (!info) return null;

  const label = info.name ?? info.packageName;
  const marked = Boolean(patched[info.packageName]);
  const isHidden = hidden.has(info.packageName);

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
          {info.category && <Badge tone="tertiary">{info.category}</Badge>}
          {marked && (
            <Badge tone="ok">
              <Icon name="check-circle" size={14} />
              Patched
            </Badge>
          )}
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
            <div
              key={repo}
              className="flex items-center gap-3 rounded-[20px] border border-outline-variant/70 bg-surface-container-low p-3"
            >
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
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="tonal"
            icon={marked ? 'undo' : 'check-circle'}
            onClick={() => {
              setPatched(info.packageName, !marked);
              show({ message: marked ? 'Mark removed.' : 'Marked as patched.' });
            }}
          >
            {marked ? 'Not patched' : 'Mark patched'}
          </Button>
          <Button
            variant="outlined"
            icon={isHidden ? 'visibility' : 'visibility-off'}
            onClick={() => {
              toggleHidden(info.packageName);
              show({ message: isHidden ? 'App unhidden.' : 'App hidden.' });
            }}
          >
            {isHidden ? 'Unhide' : 'Hide'}
          </Button>
          <Button variant="text" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
