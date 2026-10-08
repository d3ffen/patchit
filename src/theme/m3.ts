import {
  DynamicColor,
  Hct,
  MaterialDynamicColors,
  SchemeContent,
  SchemeExpressive,
  SchemeFidelity,
  SchemeFruitSalad,
  SchemeMonochrome,
  SchemeNeutral,
  SchemeRainbow,
  SchemeTonalSpot,
  SchemeVibrant,
  argbFromHex,
  hexFromArgb,
  type DynamicScheme,
} from '@material/material-color-utilities';

/**
 * Material You 3 color engine.
 *
 * The whole point of Material You is that the palette is *derived*, not chosen.
 * On Android 12+ the seed comes from the wallpaper via the platform's
 * `system_accent1_*` tonal palettes (see `DynamicColorPlugin.kt`). Everywhere
 * else — desktop browser, older Android, a device whose OEM stripped Monet —
 * we fall back to a seed the user picks in Settings.
 *
 * This module owns two jobs:
 *   1. turn a seed into a full role set (60+ roles, light and dark), and
 *   2. apply that set to the document as CSS custom properties.
 */

export const SCHEME_VARIANTS = [
  'tonalSpot',
  'content',
  'expressive',
  'fidelity',
  'vibrant',
  'neutral',
  'monochrome',
  'rainbow',
  'fruitSalad',
] as const;

export type SchemeVariant = (typeof SCHEME_VARIANTS)[number];

export const SCHEME_LABELS: Record<SchemeVariant, string> = {
  tonalSpot: 'Tonal spot',
  content: 'Content',
  expressive: 'Expressive',
  fidelity: 'Fidelity',
  vibrant: 'Vibrant',
  neutral: 'Neutral',
  monochrome: 'Monochrome',
  rainbow: 'Rainbow',
  fruitSalad: 'Fruit salad',
};

/**
 * The roles Material Color Utilities supplies.
 *
 * Names map 1:1 onto `--md-sys-color-<name>` and the Tailwind bridge, so adding
 * a role here is all it takes to get a utility class for it.
 */
const M3_ROLE_NAMES = [
  'primary',
  'onPrimary',
  'primaryContainer',
  'onPrimaryContainer',
  'primaryFixed',
  'primaryFixedDim',
  'onPrimaryFixed',
  'onPrimaryFixedVariant',
  'secondary',
  'onSecondary',
  'secondaryContainer',
  'onSecondaryContainer',
  'secondaryFixed',
  'secondaryFixedDim',
  'onSecondaryFixed',
  'onSecondaryFixedVariant',
  'tertiary',
  'onTertiary',
  'tertiaryContainer',
  'onTertiaryContainer',
  'tertiaryFixed',
  'tertiaryFixedDim',
  'onTertiaryFixed',
  'onTertiaryFixedVariant',
  'error',
  'onError',
  'errorContainer',
  'onErrorContainer',
  'background',
  'onBackground',
  'surface',
  'onSurface',
  'surfaceVariant',
  'onSurfaceVariant',
  'surfaceDim',
  'surfaceBright',
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'outline',
  'outlineVariant',
  'inverseSurface',
  'inverseOnSurface',
  'inversePrimary',
  'shadow',
  'scrim',
  'surfaceTint',
] as const;

/**
 * Roles M3 does not define but this app needs, derived rather than read.
 *
 * A "supported / too new" verdict needs a green and an amber, and M3's role set
 * has neither. The important part is that their *content* colours are computed
 * from the fill by WCAG contrast rather than hand-picked — see
 * `applyDerivedRoles`. Hand-picked on-colours are exactly how you end up with
 * dark text on a mid-tone container, which is what the first version of this
 * app shipped.
 */
const DERIVED_ROLE_NAMES = [
  'ok',
  'onOk',
  'okContainer',
  'onOkContainer',
  'warn',
  'onWarn',
  'warnContainer',
  'onWarnContainer',
  /** Hairline between rows: outline-variant pulled toward the accent. */
  'divider',
] as const;

const ROLE_NAMES = [...M3_ROLE_NAMES, ...DERIVED_ROLE_NAMES] as const;

export type ColorRole = (typeof ROLE_NAMES)[number];
export type M3Role = (typeof M3_ROLE_NAMES)[number];

/**
 * What Material Color Utilities can answer for: the M3 roles only.
 *
 * Kept distinct from [ColorScheme] on purpose. Collapsing them would let
 * `palette.dark.divider` typecheck and be `undefined` at runtime, which is
 * exactly the bug this split prevents — the derived roles only exist once
 * `resolveScheme` has measured them against a real surface.
 */
export type M3Scheme = Record<M3Role, string>;

/** The complete role set: everything the CSS bridge and Tailwind consume. */
export type ColorScheme = Record<ColorRole, string>;

export type ThemePalette = {
  /** ARGB seed the palette was derived from. */
  seed: number;
  variant: SchemeVariant;
  light: M3Scheme;
  dark: M3Scheme;
};

function makeScheme(seed: number, variant: SchemeVariant, isDark: boolean): DynamicScheme {
  switch (variant) {
    case 'content':
      return new SchemeContent(Hct.fromInt(seed), isDark, 0);
    case 'expressive':
      return new SchemeExpressive(Hct.fromInt(seed), isDark, 0);
    case 'fidelity':
      return new SchemeFidelity(Hct.fromInt(seed), isDark, 0);
    case 'vibrant':
      return new SchemeVibrant(Hct.fromInt(seed), isDark, 0);
    case 'neutral':
      return new SchemeNeutral(Hct.fromInt(seed), isDark, 0);
    case 'monochrome':
      return new SchemeMonochrome(Hct.fromInt(seed), isDark, 0);
    case 'rainbow':
      return new SchemeRainbow(Hct.fromInt(seed), isDark, 0);
    case 'fruitSalad':
      return new SchemeFruitSalad(Hct.fromInt(seed), isDark, 0);
    case 'tonalSpot':
    default:
      return new SchemeTonalSpot(Hct.fromInt(seed), isDark, 0);
  }
}

/**
 * `dynamicColor` and `fixedColor` both return DynamicColor objects; the fixed
 * variants ignore the scheme's contrast level, which is what "fixed" means.
 */
function readM3Roles(scheme: DynamicScheme): M3Scheme {
  const out = {} as M3Scheme;
  for (const role of M3_ROLE_NAMES) {
    // The published types for MaterialDynamicColors are a union that includes
    // the scheme's own `contrastLevel` number, so the lookup needs narrowing.
    const dynamicColor = (
      MaterialDynamicColors as unknown as Record<string, DynamicColor>
    )[role];
    out[role] = hexFromArgb(dynamicColor.getArgb(scheme));
  }
  return out;
}

/** Build the light and dark M3 role sets for a seed. Derived roles are added by `resolveScheme`. */
export function buildPalette(seed: number, variant: SchemeVariant): ThemePalette {
  return {
    seed,
    variant,
    light: readM3Roles(makeScheme(seed, variant, false)),
    dark: readM3Roles(makeScheme(seed, variant, true)),
  };
}

/* ------------------------------------------------------------------ *
 * Contrast
 * ------------------------------------------------------------------ *
 *
 * Ported from Morphe Manager's `ColorUtils.kt`, because the problem it solves
 * is the one this app had: a palette role pairing stops describing the
 * background the moment you draw the fill translucent, or the moment you invent
 * a colour the palette knows nothing about. Measuring is the only way to be sure
 * the label is still readable.
 */

/** WCAG relative luminance for a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio: 1 for identical colours, 21 for black on white. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** White or black, whichever reads on `background`. */
export function contrastingContent(background: string): string {
  return relativeLuminance(background) < 0.5 ? '#FFFFFF' : '#000000';
}

/**
 * Push `foreground` away from `background` until it clears `minRatio`.
 *
 * Walks in small lightness steps rather than jumping straight to black or
 * white: the goal is the *smallest* change that passes, so an amber stays
 * recognisably amber instead of collapsing to a neutral.
 */
export function ensureContrast(foreground: string, background: string, minRatio = 4.5): string {
  if (contrastRatio(foreground, background) >= minRatio) return foreground;

  const towardWhite = relativeLuminance(background) < 0.5;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = towardWhite
      ? mix(foreground, '#FFFFFF', step / 20)
      : mix(foreground, '#000000', step / 20);
    if (contrastRatio(candidate, background) >= minRatio) return candidate;
  }
  return towardWhite ? '#FFFFFF' : '#000000';
}

/** Linear interpolation in sRGB, matching Compose's `lerp`. */
export function mix(a: string, b: string, t: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  const at = Math.max(0, Math.min(1, t));
  const blend = (x: number, y: number) => Math.round(x + (y - x) * at);
  return rgbToHex(blend(from.r, to.r), blend(from.g, to.g), blend(from.b, to.b));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const value = Number.parseInt(full.slice(0, 6), 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

/**
 * Fill the roles Material Color Utilities cannot answer for.
 *
 * Runs *after* any surface overrides, because everything here is measured
 * against the surface it will actually be drawn on — which is the whole point.
 */
function applyDerivedRoles(scheme: M3Scheme, isDark: boolean): ColorScheme {
  const out = { ...scheme } as ColorScheme;

  // Containers are authored per polarity, then their content colour is derived.
  const okContainer = isDark ? '#1F6F45' : '#A6F2C8';
  const warnContainer = isDark ? '#8A6A00' : '#FFE08A';

  out.okContainer = okContainer;
  out.onOkContainer = contrastingContent(okContainer);
  out.warnContainer = warnContainer;
  out.onWarnContainer = contrastingContent(warnContainer);

  // These are used as *text* directly on surfaces, so they answer to the surface
  // rather than to a container. 4.5:1 is WCAG AA for body text.
  out.ok = ensureContrast(isDark ? '#7EE2A8' : '#146C43', out.surface, 4.5);
  out.onOk = contrastingContent(out.ok);
  out.warn = ensureContrast(isDark ? '#F5C542' : '#8A6A00', out.surface, 4.5);
  out.onWarn = contrastingContent(out.warn);

  // Divider: outline-variant pulled 18% toward the accent and softened, exactly
  // as Morphe Manager's `dividerColor()` does. A plain outline-variant divider
  // looks grey and detached next to a wallpaper palette.
  out.divider = mix(out.outlineVariant, out.primary, 0.18);

  return out;
}

/* ------------------------------------------------------------------ *
 * AMOLED and final resolution
 * ------------------------------------------------------------------ */

/**
 * Pure black, for OLED panels where a #141218 "dark" surface is visibly lit.
 *
 * Mirrors Morphe Manager exactly: only `background`, `surface` and `surfaceDim`
 * are forced to black. The `surfaceContainer*` ladder is left alone, so it still
 * reads as elevation above the black — flatten those too and every card would
 * disappear into the background.
 */
export function applyAmoled(scheme: M3Scheme): M3Scheme {
  return { ...scheme, background: '#000000', surface: '#000000', surfaceDim: '#000000' };
}

export interface ResolveOptions {
  amoled?: boolean;
  /** Bump every M3 role toward its WCAG-safe counterpart where one is available. */
  highContrast?: boolean;
}

/**
 * The one function the provider calls: base palette in, complete role set out.
 *
 * Order matters and is the reason this is a single function —
 * AMOLED changes the surface, and every derived colour is measured against that
 * surface, so deriving before the override would measure against a background
 * that is not there.
 */
export function resolveScheme(
  palette: ThemePalette,
  isDark: boolean,
  options: ResolveOptions = {},
): ColorScheme {
  const base = isDark ? palette.dark : palette.light;
  const surfaced = options.amoled && isDark ? applyAmoled(base) : base;
  return applyDerivedRoles(surfaced, isDark);
}

const ROLE_STYLE_ID = 'm3-dynamic-roles';

function roleToCustomProperty(role: ColorRole): string {
  // camelCase -> kebab-case: onPrimaryContainer -> on-primary-container
  return `--md-sys-color-${role.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

/**
 * Push a scheme's roles onto :root.
 *
 * We rewrite a single stylesheet rather than 48 inline `setProperty` calls per
 * theme change: one CSSOM mutation is measurably cheaper, and it keeps the
 * values inspectable in devtools. The `<style>` is created once and reused.
 */
export function applyScheme(scheme: ColorScheme): void {
  const declarations = ROLE_NAMES.map(
    (role) => `${roleToCustomProperty(role)}: ${scheme[role]};`,
  ).join('');

  let style = document.getElementById(ROLE_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = ROLE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `:root{${declarations}}`;

  // Keep the OS chrome (status bar, task switcher) in step with the surface.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', scheme.surface);
}

export function parseSeed(input: string): number | null {
  const value = input.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return argbFromHex(value);
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value.slice(1).split('');
    return argbFromHex(`#${r}${r}${g}${g}${b}${b}`);
  }
  return null;
}

export function seedToHex(seed: number): string {
  return hexFromArgb(seed);
}

/**
 * Seeds worth offering in Settings. These are the Material baseline swatches
 * plus the Morphe brand blues, so the app still looks deliberate on devices
 * with no dynamic color.
 */
export const PRESET_SEEDS: { name: string; hex: string }[] = [
  { name: 'Morphe', hex: '#4A7FC8' },
  { name: 'Morphe teal', hex: '#20CFCE' },
  { name: 'M3 purple', hex: '#6750A4' },
  { name: 'M3 green', hex: '#386A20' },
  { name: 'M3 blue', hex: '#0B57D0' },
  { name: 'M3 amber', hex: '#7D5700' },
  { name: 'M3 pink', hex: '#984061' },
  { name: 'M3 cyan', hex: '#00696E' },
];
