import { useEffect, useState } from 'react';
import { clearHttpCache, clearSnapshot, estimateUsage } from '@/registry/cache';
import {
  PRESET_SEEDS,
  SCHEME_LABELS,
  SCHEME_VARIANTS,
  seedToHex,
  type SchemeVariant,
} from '@/theme/m3';
import { useTheme, type ColorStyle, type ThemeMode } from '@/theme/ThemeProvider';
import { useStore } from '@/state/store';
import { Icon } from '@/ui/icons';
import { Scaffold, SectionHeader, TopAppBar } from '@/ui/layout';
import {
  Badge,
  BottomSheet,
  Button,
  Card,
  Chip,
  Divider,
  ListItem,
  Segmented,
  Switch,
  useSnackbar,
} from '@/ui/primitives';

/**
 * Settings.
 *
 * The appearance section is not a colour picker bolted on: Material You means
 * the palette is derived from a seed, so the control is *which seed*, and the
 * preview below shows the roles the current seed produces. When the device
 * supplies a wallpaper palette the manual seed is explicitly greyed out and
 * explained, rather than silently ignored.
 */
export function SettingsScreen() {
  const theme = useTheme();
  const { snapshot, sources, apps, lastSyncAt, sync, setLogsOpen } = useStore();
  const { show } = useSnackbar();
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void estimateUsage().then((value) => {
      if (!cancelled) setStorage(value);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  const formatBytes = (bytes: number) =>
    bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;

  return (
    <Scaffold
      appBar={<TopAppBar title="Settings" subtitle="Appearance, registry and diagnostics" />}
    >
      {/* --- Appearance ------------------------------------------- */}
      <SectionHeader>Appearance</SectionHeader>
      <Card variant="outlined" className="mx-4 p-4">
        <p className="md-title-small mb-2 text-on-surface">Theme</p>
        <Segmented
          value={theme.settings.mode}
          onChange={(mode: ThemeMode) => theme.setSettings({ mode })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />

        <Divider className="my-4" />

        <p className="md-title-small mb-1 text-on-surface">Colour style</p>
        <p className="md-body-small mb-3 text-on-surface-variant">
          Where the palette comes from. Dynamic follows the wallpaper; Custom derives the same role
          set from one seed; Mono keeps the tonal ladder and drops every hue.
        </p>
        <Segmented
          value={theme.settings.colorStyle}
          onChange={(colorStyle: ColorStyle) => theme.setSettings({ colorStyle })}
          options={[
            { value: 'dynamic', label: 'Dynamic', icon: 'palette' },
            { value: 'custom', label: 'Custom', icon: 'tune' },
            { value: 'monochrome', label: 'Mono', icon: 'visibility-off' },
          ]}
        />

        <p className="md-body-small mt-2 text-on-surface-variant">
          {theme.settings.colorStyle === 'monochrome'
            ? 'Neutral greys, no hue at all. Content colours are derived the same way in every style.'
            : theme.settings.colorStyle === 'custom'
              ? 'Every role is derived from the seed colour below.'
              : theme.usingDynamicColor
                ? `Following your wallpaper (seed ${theme.palette.seed ? seedToHex(theme.palette.seed) : '—'}).`
                : theme.dynamicUnavailableReason ??
                  'This device offers no wallpaper palette, so a seed is used instead.'}
        </p>

        {theme.settings.colorStyle === 'custom' && (
          <button
            type="button"
            onClick={() => setSheetsOpen(true)}
            className="md-label-large mt-3 text-primary"
          >
            Choose a seed colour →
          </button>
        )}

        <Divider className="my-4" />

        {/*
          AMOLED is not "a darker dark". It forces the three darkest surface
          roles to pure black and leaves the container ladder alone, which is
          exactly what Morphe Manager does — flatten the containers too and every
          card would vanish into the background.
        */}
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="md-body-large text-on-surface">AMOLED black</p>
            <p className="md-body-medium text-on-surface-variant">
              Pure black behind everything. On an OLED panel a “dark” surface is still lit and still
              draws power; cards keep their container tones and gain a hairline edge so they stay
              distinct without shadows.
            </p>
          </div>
          <Switch
            checked={theme.settings.amoled}
            onCheckedChange={(amoled) => theme.setSettings({ amoled })}
            label="AMOLED black"
          />
        </div>

        {theme.androidSdk > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">Android SDK {theme.androidSdk}</Badge>
            <Badge tone="neutral">
              {theme.settings.amoled && theme.isDark ? 'pure black surfaces' : 'tonal surfaces'}
            </Badge>
          </div>
        )}

        {/*
          Palette preview, including the derived `ok` / `warn` roles. Those two
          are the ones that were illegible before the contrast work, so showing
          them here is a check the user can actually perform.
        */}
        <div className="mt-4 grid grid-cols-6 gap-1.5">
          {(
            [
              'primary',
              'primaryContainer',
              'secondary',
              'secondaryContainer',
              'tertiary',
              'tertiaryContainer',
              'surface',
              'surfaceContainerHigh',
              'ok',
              'okContainer',
              'warn',
              'divider',
            ] as const
          ).map((role) => (
            <div key={role} className="flex flex-col items-center gap-1">
              <div
                className="h-8 w-full rounded-md border border-outline-variant/40"
                style={{ background: theme.scheme[role] }}
                title={`${role}: ${theme.scheme[role]}`}
              />
              <span className="md-label-small w-full truncate text-center text-on-surface-variant">
                {role.replace(/([A-Z])/g, ' $1').trim().split(' ')[0]}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* --- Registry --------------------------------------------- */}
      <SectionHeader>Registry</SectionHeader>
      <Card variant="outlined" className="mx-4 overflow-hidden p-0">
        <ListItem
          headline="Offline cache"
          supporting={
            snapshot
              ? `${snapshot.bundles.length} bundles cached · synced ${lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never'}`
              : 'Nothing cached yet'
          }
          trailing={<Badge tone={snapshot ? 'ok' : 'warn'}>{snapshot ? 'ready' : 'empty'}</Badge>}
        />
        <Divider inset />
        <ListItem
          headline="Storage used"
          supporting={
            storage
              ? `${formatBytes(storage.usage)} of ${formatBytes(storage.quota)} available to the app`
              : 'Unavailable in this WebView'
          }
        />
        <Divider inset />
        <ListItem
          headline="Active sources"
          supporting={`${sources.filter((s) => s.enabled).length} of ${sources.length} enabled`}
        />
        <Divider inset />
        <ListItem
          headline="Scanned packages"
          supporting={`${apps.length} apps in the last scan`}
          trailing={
            <Button variant="text" icon="refresh" onClick={() => void sync({ force: true })}>
              Sync
            </Button>
          }
        />
      </Card>

      <div className="mt-3 flex flex-wrap gap-2 px-4">
        <Button
          variant="outlined"
          icon="refresh"
          onClick={async () => {
            await clearHttpCache();
            await sync({ force: true });
            show({ message: 'Re-downloading every source.' });
          }}
        >
          Force full re-sync
        </Button>
        <Button variant="danger" icon="delete" onClick={() => setConfirmWipe(true)}>
          Clear cached registry
        </Button>
      </div>

      {/* --- Diagnostics ------------------------------------------ */}
      <SectionHeader>Diagnostics</SectionHeader>
      <Card variant="outlined" className="mx-4 overflow-hidden p-0">
        <ListItem
          onClick={() => setLogsOpen(true)}
          leading={
            <div className="grid size-10 flex-none place-items-center rounded-md bg-secondary-container text-on-secondary-container">
              <Icon name="terminal" size={20} />
            </div>
          }
          headline="Open the log viewer"
          supporting="The last 500 entries, including uncaught errors and registry warnings."
          trailing={<Icon name="chevron-right" size={20} className="text-on-surface-variant" />}
        />
        <Divider inset />
        <ListItem
          headline="Log buffer"
          supporting="Keeps the last 500 entries in memory, including uncaught errors."
        />
        <Divider inset />
        <ListItem
          headline="Registry warnings"
          supporting={
            snapshot?.warnings.length
              ? `${snapshot.warnings.length} warning${snapshot.warnings.length === 1 ? '' : 's'} from the last parse`
              : 'No warnings from the last parse'
          }
          trailing={<Badge tone={snapshot?.warnings.length ? 'warn' : 'ok'}>
            {snapshot?.warnings.length ?? 0}
          </Badge>}
        />
      </Card>

      {/* --- About ------------------------------------------------ */}
      <SectionHeader>About</SectionHeader>
      <Card variant="outlined" className="mx-4 p-4">
        <p className="md-body-medium text-on-surface">
          PatchIt reads the Morphe patch ecosystem and compares it against what is installed on
          this device, then hands the covering patch sources to Morphe Manager. It never patches
          anything itself — Morphe does that, with you watching.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone="neutral">PatchIt v1.0.0</Badge>
          <Badge tone="neutral">Capacitor {`7`}</Badge>
          <Badge tone="neutral">Material You 3</Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outlined"
            icon="open-in-new"
            onClick={() =>
              window.open('https://github.com/MorpheApp/morphe-patches', '_blank', 'noopener')
            }
          >
            Official patches
          </Button>
          <Button
            variant="outlined"
            icon="open-in-new"
            onClick={() => window.open('https://morphe-patches.software/', '_blank', 'noopener')}
          >
            Community index
          </Button>
        </div>
      </Card>

      <div className="h-6" />

      {/* --- Seed picker ------------------------------------------- */}
      <BottomSheet open={sheetsOpen} onClose={() => setSheetsOpen(false)} title="Seed colour">
        <div className="px-6 pb-6">
          <p className="md-body-medium text-on-surface-variant">
            Every Material You role is derived from one seed. Pick one, then pick a scheme variant to
            change how far the palette strays from it.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {PRESET_SEEDS.map((preset) => {
              const selected =
                theme.settings.colorStyle === 'custom' &&
                preset.hex.toLowerCase() === theme.settings.seedHex.toLowerCase();
              return (
                <Chip
                  key={preset.hex}
                  selected={selected}
                  checkOnSelect={false}
                  onClick={() => theme.setSettings({ seedHex: preset.hex, colorStyle: 'custom' })}
                >
                  <span
                    className="mr-1 inline-block size-4 rounded-full border border-outline-variant"
                    style={{ background: preset.hex }}
                  />
                  {preset.name}
                </Chip>
              );
            })}
          </div>

          <div className="mt-6">
            <p className="md-title-small mb-2 text-on-surface">Scheme variant</p>
            <div className="flex flex-wrap gap-2">
              {SCHEME_VARIANTS.map((variant) => (
                <Chip
                  key={variant}
                  selected={theme.settings.variant === variant}
                  onClick={() => theme.setSettings({ variant: variant as SchemeVariant })}
                >
                  {SCHEME_LABELS[variant]}
                </Chip>
              ))}
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button variant="filled" onClick={() => setSheetsOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      </BottomSheet>

      {/* --- Wipe confirmation ------------------------------------- */}
      <BottomSheet
        open={confirmWipe}
        onClose={() => setConfirmWipe(false)}
        title="Clear the cached registry?"
      >
        <div className="px-6 pb-6">
          <p className="md-body-medium text-on-surface-variant">
            This drops the parsed snapshot and every cached HTTP response. Your app list and settings
            are kept, and the next sync re-downloads everything — about 2.5 MB.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="text" onClick={() => setConfirmWipe(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="delete"
              onClick={async () => {
                await clearSnapshot();
                await clearHttpCache();
                setConfirmWipe(false);
                show({ message: 'Cache cleared. Syncing…' });
                void sync({ force: true });
              }}
            >
              Clear and re-sync
            </Button>
          </div>
        </div>
      </BottomSheet>
    </Scaffold>
  );
}


