import { useCallback, useMemo, useState } from 'react';
import { addRepoToMorphe } from '@/core/morphe';
import { resolveInput } from '@/registry/sources';
import { useStore } from '@/state/store';
import { Icon } from '@/ui/icons';
import { Scaffold, SectionHeader, TopAppBar } from '@/ui/layout';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Divider,
  EmptyState,
  Fab,
  IconButton,
  ListItem,
  SearchBar,
  Switch,
  TextField,
  cx,
  useSnackbar,
} from '@/ui/primitives';

/**
 * Patch sources.
 *
 * The default registry is two entries and neither is editable, which is worth
 * reinforcing visually: the official list and the community index are *the*
 * registry, and everything a user adds sits alongside them. A source that fails
 * to sync keeps its row and shows the error inline, because a silently missing
 * source is indistinguishable from a source with no patches for your apps.
 */
export function SourcesScreen() {
  const { sources, snapshot, snapshotOrigin, sync, syncing, addSource, removeSource, toggleSource } =
    useStore();
  const [addOpen, setAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const { show } = useSnackbar();

  const bundleCounts = useMemo(() => {
    const counts = new Map<string, { bundles: number; patches: number; apps: Set<string> }>();
    for (const source of sources) counts.set(source.id, { bundles: 0, patches: 0, apps: new Set() });

    for (const bundle of snapshot?.bundles ?? []) {
      const entry = counts.get(bundle.sourceId);
      if (!entry) continue;
      entry.bundles += 1;
      entry.patches += bundle.patches.length;
      for (const app of bundle.targetApps) entry.apps.add(app);
    }
    return counts;
  }, [sources, snapshot]);

  const totalBundles = snapshot?.bundles.length ?? 0;
  const totalApps = useMemo(() => {
    const apps = new Set<string>();
    for (const bundle of snapshot?.bundles ?? []) {
      for (const app of bundle.targetApps) apps.add(app);
    }
    return apps.size;
  }, [snapshot]);

  /**
   * Patch-name matches per source.
   *
   * Morphe searches patch names alongside source names, and it is the right call:
   * "which source carries the Spotify patch?" is a question the source list alone
   * cannot answer, and making somebody open eight sources to find out is worse
   * than the cost of scanning patch names.
   */
  const patchMatchCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const needle = query.trim().toLowerCase();
    if (!needle) return counts;

    for (const bundle of snapshot?.bundles ?? []) {
      let matches = 0;
      for (const patch of bundle.patches) {
        if (
          patch.name.toLowerCase().includes(needle) ||
          (patch.description ?? '').toLowerCase().includes(needle)
        ) {
          matches += 1;
        }
      }
      if (matches > 0) {
        counts.set(bundle.sourceId, (counts.get(bundle.sourceId) ?? 0) + matches);
      }
    }
    return counts;
  }, [snapshot, query]);

  /** Sources whose own name, repo or URL matches — ranked above patch hits. */
  const sourceNameMatches = useCallback(
    (source: (typeof sources)[number]) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return `${source.name} ${source.repo ?? ''} ${source.indexUrl}`.toLowerCase().includes(needle);
    },
    [query],
  );

  const visibleSources = useMemo(() => {
    if (!query.trim()) return sources;

    return sources
      .filter((source) => sourceNameMatches(source) || (patchMatchCounts.get(source.id) ?? 0) > 0)
      .sort((a, b) => {
        // A source the query names is the one that was asked for; the rest rank
        // by how much of the query they carry. Array.sort is stable, so ties
        // keep the order they had before the query was typed.
        const named = Number(sourceNameMatches(b)) - Number(sourceNameMatches(a));
        if (named !== 0) return named;
        return (patchMatchCounts.get(b.id) ?? 0) - (patchMatchCounts.get(a.id) ?? 0);
      });
  }, [sources, query, patchMatchCounts, sourceNameMatches]);

  const detailSource = sources.find((s) => s.id === detailId) ?? null;
  const detailBundles = useMemo(
    () => (snapshot?.bundles ?? []).filter((b) => b.sourceId === detailId),
    [snapshot, detailId],
  );

  return (
    <Scaffold
      appBar={
        <TopAppBar
          title="Patch sources"
          subtitle={
            syncing
              ? 'Syncing…'
              : `${totalBundles} bundles · ${totalApps} apps covered`
          }
          actions={
            <>
              <IconButton
                icon={searchOpen ? 'close' : 'search'}
                label={searchOpen ? 'Close search' : 'Search sources'}
                selected={searchOpen}
                onClick={() => {
                  setSearchOpen((open) => !open);
                  if (searchOpen) setQuery('');
                }}
              />
              <IconButton
                icon="sync"
                label="Sync all sources"
                disabled={syncing}
                onClick={() => void sync({ force: true })}
              />
            </>
          }
        />
      }
      fab={<Fab icon="add" label="Add patch source" onClick={() => setAddOpen(true)} />}
    >
      {snapshotOrigin === 'bundled' && (
        <div className="mx-4 mt-4 flex items-start gap-3 rounded-md bg-surface-container-high px-4 py-3">
          <Icon name="cloud-off" size={20} className="mt-0.5 flex-none text-on-surface-variant" />
          <p className="md-body-medium flex-1 text-on-surface-variant">
            Showing the registry bundled with the app, not live data. Pull to sync once you have a
            connection and the versions here will refresh.
          </p>
        </div>
      )}

      {snapshot && snapshot.warnings.length > 0 && (
        <div className="mx-4 mt-4 rounded-md bg-warn-container p-4 text-on-warn-container">
          <div className="flex items-center gap-2">
            <Icon name="warning" size={20} />
            <p className="md-title-small">
              {snapshot.warnings.length} registry warning{snapshot.warnings.length === 1 ? '' : 's'}
            </p>
          </div>
          <ul className="md-body-small mt-2 flex list-disc flex-col gap-1 pl-5">
            {snapshot.warnings.slice(0, 4).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
            {snapshot.warnings.length > 4 && <li>…and {snapshot.warnings.length - 4} more in the log.</li>}
          </ul>
        </div>
      )}

      {searchOpen && (
        <div className="md-floating-search">
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder="Search sources and patches"
            className="shadow-e2"
            trailing={
              query ? (
                <IconButton icon="close" label="Clear search" size={24} onClick={() => setQuery('')} />
              ) : undefined
            }
          />
        </div>
      )}

      <SectionHeader
        trailing={
          query.trim() ? (
            <span className="md-label-medium text-on-surface-variant">
              {visibleSources.length} of {sources.length}
            </span>
          ) : undefined
        }
      >
        Registry
      </SectionHeader>

      {visibleSources.length === 0 ? (
        <EmptyState
          icon="search"
          title="No matching sources"
          body={`Nothing matches “${query.trim()}” by name or by patch.`}
        />
      ) : (
      <Card variant="outlined" className="mx-4 overflow-hidden p-0">
        {visibleSources.map((source, index) => {
          const counts = bundleCounts.get(source.id);
          const isBuiltIn = source.kind === 'official' || source.kind === 'community';

          return (
            <div key={source.id}>
              {index > 0 && <Divider inset />}
              <ListItem
                onClick={() => setDetailId(source.id)}
                leading={
                  <div
                    className={cx(
                      'grid size-10 flex-none place-items-center rounded-md',
                      source.kind === 'official'
                        ? 'bg-primary-container text-on-primary-container'
                        : source.kind === 'community'
                          ? 'bg-tertiary-container text-on-tertiary-container'
                          : 'bg-secondary-container text-on-secondary-container',
                    )}
                  >
                    <Icon
                      name={source.kind === 'official' ? 'verified' : source.kind === 'community' ? 'database' : 'source'}
                      size={20}
                    />
                  </div>
                }
                headline={
                  <span className="flex items-center gap-2">
                    {source.name}
                    {isBuiltIn && <Badge tone="primary">built-in</Badge>}
                    {!source.enabled && <Badge tone="neutral">disabled</Badge>}
                    {source.lastSyncError && <Badge tone="error">error</Badge>}
                  </span>
                }
                supporting={
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="md-body-small">{source.repo ?? source.indexUrl}</span>
                    <span className="text-outline">·</span>
                    <span>
                      {counts?.bundles ?? 0} bundles · {counts?.patches ?? 0} patches ·{' '}
                      {counts?.apps.size ?? 0} apps
                    </span>
                  </span>
                }
                trailing={
                  <div className="flex flex-none items-center gap-1">
                    <Switch
                      checked={source.enabled}
                      onCheckedChange={() => void toggleSource(source.id)}
                      label={`Enable ${source.name}`}
                    />
                  </div>
                }
              />
              {source.lastSyncError && (
                <p className="md-body-small px-4 pb-3 pl-16 text-error">{source.lastSyncError}</p>
              )}
            </div>
          );
        })}
      </Card>
      )}

      {sources.length === 0 && (
        <EmptyState
          icon="source"
          title="No sources"
          body="Add a patch repository, or reinstall the app to restore the built-in registry."
        />
      )}

      <div className="mt-4 px-4">
        <p className="md-body-small text-on-surface-variant">
          Repositories are fetched from raw.githubusercontent.com and the community index from
          morphe-patches.software. A repository needs a patches-list.json or patches-bundle.json at
          its root.
        </p>
      </div>

      {/* --- Add source -------------------------------------------- */}
      <AddSourceSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={async (input) => {
          const result = await addSource(input);
          show({ message: result.message });
          if (result.ok) setAddOpen(false);
          return result;
        }}
      />

      {/* --- Source detail ----------------------------------------- */}
      <BottomSheet
        open={Boolean(detailSource)}
        onClose={() => setDetailId(null)}
        title={detailSource?.name}
      >
        {detailSource && (
          <div className="px-6 pb-6">
            <p className="md-body-small break-all text-on-surface-variant">
              {detailSource.indexUrl}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <Stat label="Bundles" value={bundleCounts.get(detailSource.id)?.bundles ?? 0} />
              <Stat label="Patches" value={bundleCounts.get(detailSource.id)?.patches ?? 0} />
              <Stat label="Apps" value={bundleCounts.get(detailSource.id)?.apps.size ?? 0} />
            </div>

            <div className="mt-4 flex flex-col gap-1">
              <Row label="Version" value={detailSource.version ?? '—'} />
              <Row
                label="Last synced"
                value={detailSource.lastSyncAt ? new Date(detailSource.lastSyncAt).toLocaleString() : 'Never'}
              />
              <Row label="Added" value={new Date(detailSource.addedAt).toLocaleDateString()} />
              <Row label="Kind" value={detailSource.kind} />
            </div>

            {detailBundles.length > 0 && (
              <>
                <h4 className="md-title-small mb-2 mt-6 text-primary">Bundles</h4>
                <div className="flex flex-col gap-1">
                  {detailBundles.slice(0, 20).map((bundle) => (
                    <div
                      key={bundle.id}
                      className="flex items-center justify-between gap-3 rounded-sm bg-surface-container-high px-3 py-2"
                    >
                      <span className="md-body-small min-w-0 flex-1 truncate">
                        {bundle.repo || bundle.name}
                      </span>
                      <Badge tone="neutral">{bundle.patchCount} patches</Badge>
                    </div>
                  ))}
                  {detailBundles.length > 20 && (
                    <p className="md-body-small text-on-surface-variant">
                      …and {detailBundles.length - 20} more.
                    </p>
                  )}
                </div>
              </>
            )}

            <div className="mt-6 flex flex-wrap gap-2">
              <Button
                variant="tonal"
                icon="sync"
                onClick={() => {
                  void sync({ force: true });
                  setDetailId(null);
                }}
              >
                Sync now
              </Button>
              {detailSource.repo && (
                <Button
                  variant="outlined"
                  icon="open-in-new"
                  onClick={async () => {
                    const outcome = await addRepoToMorphe(detailSource.repo!);
                    show({ message: outcome.message });
                  }}
                >
                  Add in Morphe
                </Button>
              )}
              {detailSource.kind !== 'official' && detailSource.kind !== 'community' && (
                <Button
                  variant="danger"
                  icon="delete"
                  onClick={async () => {
                    await removeSource(detailSource.id);
                    setDetailId(null);
                    show({ message: `${detailSource.name} removed.` });
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        )}
      </BottomSheet>
    </Scaffold>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface-container-high px-3 py-2">
      <div className="md-title-large text-on-surface">{value}</div>
      <div className="md-label-medium text-on-surface-variant">{label}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="md-body-medium text-on-surface-variant">{label}</span>
      <span className="md-body-medium text-on-surface">{value}</span>
    </div>
  );
}

/**
 * The add-source flow validates as you type, using the same resolver the store
 * uses, so the message under the field is the real reason and not a guess.
 */
function AddSourceSheet({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(() => (value.trim() ? resolveInput(value) : null), [value]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await onSubmit(value);
      if (!result.ok) setError(result.message);
      else setValue('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Add a patch source">
      <div className="px-6 pb-6">
        <TextField
          label="owner/repo or https://…/patches-list.json"
          leadingIcon="link"
          value={value}
          error={error ?? (value.trim() && resolved?.error ? resolved.error : null)}
          helper={
            resolved && !resolved.error
              ? `Will try: ${resolved.candidates[0]}`
              : 'GitHub or GitLab repository, or a direct link to a patch index.'
          }
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />

        <div className="mt-4 flex items-start gap-3 rounded-md bg-surface-container-high px-4 py-3">
          <Icon name="shield" size={20} className="mt-0.5 flex-none text-on-surface-variant" />
          <p className="md-body-medium text-on-surface-variant">
            Only add sources you trust. A patch source decides what ends up inside your patched
            apps.
          </p>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="text" onClick={onClose}>
            Cancel
          </Button>
          <Button
            icon="add"
            loading={busy}
            disabled={!value.trim() || Boolean(resolved?.error)}
            onClick={() => void submit()}
          >
            Add source
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
