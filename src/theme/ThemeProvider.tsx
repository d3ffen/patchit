import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SystemTheme } from '@/native/plugins';
import { log } from '@/diagnostics/logger';
import { kvGet, kvSet } from '@/registry/cache';
import {
  applyScheme,
  buildPalette,
  parseSeed,
  resolveScheme,
  seedToHex,
  type ColorScheme,
  type SchemeVariant,
  type ThemePalette,
} from './m3';

/**
 * Material You theme controller.
 *
 * The interesting decision here is what "dynamic" means when the device cannot
 * do it. Android 12+ gives us the wallpaper palette and we use it verbatim. On
 * anything older — or an OEM build with Monet stripped — we do *not* fall back
 * to a static purple; we derive the same 48 roles from a seed colour the user
 * picks, using the identical Material algorithm. The result is still Material
 * You, just with a chosen seed instead of a stolen one.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * How the palette is chosen. Mirrors Morphe Manager's "colour style" setting,
 * which offers the same three: follow the wallpaper, derive from a seed, or
 * flatten to neutral.
 */
export type ColorStyle = 'dynamic' | 'custom' | 'monochrome';

export interface ThemeSettings {
  mode: ThemeMode;
  colorStyle: ColorStyle;
  /**
   * Seed used by the `custom` style. Ignored under the other two, so a stale
   * seed cannot quietly take effect later.
   */
  seedHex: string;
  variant: SchemeVariant;
  /**
   * Force the darkest surfaces to pure black. For OLED panels, where a
   * #141218 "dark" surface is visibly lit and costs real battery.
   */
  amoled: boolean;
}

const DEFAULT_SETTINGS: ThemeSettings = {
  mode: 'dark',
  colorStyle: 'dynamic',
  seedHex: '#4A7FC8',
  variant: 'tonalSpot',
  amoled: false,
};

/**
 * Monochrome keeps the tonal ladder but drops every hue, which is what Morphe
 * Manager's monochrome style does. `SchemeMonochrome` is Material's own answer
 * and produces exactly that, so the style is a variant choice rather than a
 * separate colour pipeline.
 */
function effectiveVariant(settings: ThemeSettings): SchemeVariant {
  if (settings.colorStyle === 'monochrome') return 'monochrome';
  if (settings.colorStyle === 'dynamic') return 'tonalSpot';
  return settings.variant;
}

const STORAGE_KEY = 'theme.settings';

interface ThemeContextValue {
  settings: ThemeSettings;
  setSettings: (next: Partial<ThemeSettings>) => void;
  /** Resolved light/dark after applying `mode`. */
  isDark: boolean;
  palette: ThemePalette;
  scheme: ColorScheme;
  /** True when the current palette came from the device wallpaper. */
  usingDynamicColor: boolean;
  /** Present when dynamic colour was wanted but the device could not supply it. */
  dynamicUnavailableReason: string | null;
  androidSdk: number;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<ThemeSettings>(DEFAULT_SETTINGS);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [systemSeed, setSystemSeed] = useState<number | null>(null);
  const [androidSdk, setAndroidSdk] = useState(0);
  const [dynamicUnavailableReason, setDynamicUnavailableReason] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const settingsRef = useRef(settings);

  settingsRef.current = settings;

  /* --- Load persisted settings + the device palette ------------------ */
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const stored = await kvGet<Partial<ThemeSettings>>(STORAGE_KEY, {});
      if (cancelled) return;

      /*
       * Settings written by the previous version have `dynamicColor: boolean`
       * and no `colorStyle`. Merging blindly would drop a user who had turned
       * dynamic off back onto the wallpaper palette and quietly discard the seed
       * they chose, so translate that one field rather than ignoring it.
       */
      const legacy = stored as Partial<ThemeSettings> & { dynamicColor?: boolean };
      if (legacy.colorStyle === undefined && legacy.dynamicColor === false) {
        legacy.colorStyle = 'custom';
      }

      const next: ThemeSettings = { ...DEFAULT_SETTINGS, ...legacy };
      setSettingsState(next);
      settingsRef.current = next;
      setHydrated(true);

      try {
        const palette = await SystemTheme.getPalette();
        if (cancelled) return;
        setAndroidSdk(palette.androidSdk);
        setSystemDark(palette.systemDark);
        if (palette.dynamicAvailable && palette.accentArgb !== null) {
          setSystemSeed(palette.accentArgb);
          setDynamicUnavailableReason(null);
          log.info('theme', 'Using the device wallpaper palette', {
            accent: seedToHex(palette.accentArgb),
            sdk: palette.androidSdk,
          });
        } else if (next.colorStyle === 'dynamic') {
          setDynamicUnavailableReason(
            palette.androidSdk === 0
              ? 'Running in a browser preview.'
              : `Dynamic colour needs Android 12+ (this device reports SDK ${palette.androidSdk}).`,
          );
          log.warn('theme', 'Dynamic colour requested but unavailable', {
            sdk: palette.androidSdk,
          });
        }
      } catch (error) {
        log.error('theme', 'Could not read the system palette', error);
        setDynamicUnavailableReason('Could not read the device palette.');
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  /* --- Follow the OS when the mode is "system" ----------------------- */
  useEffect(() => {
    let handle: { remove: () => Promise<void> } | null = null;
    let disposed = false;

    void SystemTheme.addListener('themeChanged', ({ dark }) => setSystemDark(dark))
      .then((h) => {
        if (disposed) void h.remove();
        else handle = h;
      })
      .catch(() => {
        // Not fatal: the media query listener below covers the browser case.
      });

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mql.addEventListener('change', onChange);

    return () => {
      disposed = true;
      mql.removeEventListener('change', onChange);
      void handle?.remove();
    };
  }, []);

  const isDark = settings.mode === 'system' ? systemDark : settings.mode === 'dark';

  const usingDynamicColor = settings.colorStyle === 'dynamic' && systemSeed !== null;

  const palette = useMemo(() => {
    const seed = usingDynamicColor && systemSeed !== null
      ? systemSeed
      : parseSeed(settings.seedHex) ?? parseSeed(DEFAULT_SETTINGS.seedHex)!;
    return buildPalette(seed, effectiveVariant(settings));
  }, [systemSeed, settings.seedHex, settings, usingDynamicColor]);

  // One call, in the one order that works: AMOLED rewrites the darkest
  // surfaces, and every derived colour is measured against them.
  const scheme = useMemo(
    () => resolveScheme(palette, isDark, { amoled: settings.amoled }),
    [palette, isDark, settings.amoled],
  );

  /* --- Paint -------------------------------------------------------- */
  useEffect(() => {
    applyScheme(scheme);
    document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
  }, [scheme, isDark]);

  const setSettings = useCallback((next: Partial<ThemeSettings>) => {
    setSettingsState((current) => {
      const merged = { ...current, ...next };
      void kvSet(STORAGE_KEY, merged);
      return merged;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      settings,
      setSettings,
      isDark,
      palette,
      scheme,
      usingDynamicColor,
      dynamicUnavailableReason,
      androidSdk,
    }),
    [
      settings,
      setSettings,
      isDark,
      palette,
      scheme,
      usingDynamicColor,
      dynamicUnavailableReason,
      androidSdk,
    ],
  );

  // Avoid a flash of the wrong scheme: hold the tree until settings are read.
  if (!hydrated) return <div className="h-full bg-surface" />;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}
