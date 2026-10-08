/**
 * Verifies every text/background pair the app renders.
 *
 * This exists because the first version of this app shipped a genuinely
 * unreadable combination: `text-on-ok-container` was hand-picked as near-black
 * on a #1f6f45 fill, which is about 3:1 — fine for large text by WCAG, muddy for
 * the body copy it was actually used on. Nothing in TypeScript, the build, or a
 * screenshot review caught it, because "looks a bit dim" is not a failing test.
 *
 * The roles are also palette-dependent: a wallpaper can hand over a tertiary
 * container that its own on-colour does not read against. So the checks run
 * across several seeds and every scheme variant, and they measure rather than
 * assume.
 *
 * Run with: npm run verify:theme
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argbFromHex } from '@material/material-color-utilities';
import {
  buildPalette,
  contrastRatio,
  resolveScheme,
  SCHEME_VARIANTS,
  type ColorRole,
} from '@/theme/m3';

/** WCAG AA for body text. The bar this app holds itself to. */
const AA_BODY = 4.5;

/** WCAG AA for large text and UI boundaries — the bar for non-text pairs. */
const AA_LARGE = 3.0;

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Content/background pairs that carry text.
 *
 * Every one of these is rendered somewhere in the app, which is why they are
 * listed explicitly rather than sampled: a role that is never used as a fill is
 * not worth asserting, and a role that is used but omitted here is the gap the
 * test would miss.
 */
const TEXT_PAIRS: [ColorRole, ColorRole][] = [
  ['onPrimary', 'primary'],
  ['onPrimaryContainer', 'primaryContainer'],
  ['onSecondary', 'secondary'],
  ['onSecondaryContainer', 'secondaryContainer'],
  ['onTertiary', 'tertiary'],
  ['onTertiaryContainer', 'tertiaryContainer'],
  ['onError', 'error'],
  ['onErrorContainer', 'errorContainer'],
  ['onOkContainer', 'okContainer'],
  ['onWarnContainer', 'warnContainer'],
  ['onSurface', 'surface'],
  ['onSurfaceVariant', 'surface'],
  ['onSurfaceVariant', 'surfaceContainerHigh'],
  ['onSurface', 'surfaceContainerHighest'],
  ['onBackground', 'background'],
  ['inverseOnSurface', 'inverseSurface'],
];

/** Foreground roles used directly on a surface, with no container of their own. */
const ON_SURFACE_PAIRS: ColorRole[] = ['ok', 'warn', 'primary', 'error'];

/** Seeds chosen to be hostile: near-black, near-white, and highly saturated. */
const SEEDS = ['#4A7FC8', '#20CFCE', '#6750A4', '#FFEB3B', '#0B0B0B', '#FAFAFA', '#D32F2F'];

console.log('=== Contrast: text pairs across seeds, variants and both schemes ===');

let worstPair = { label: '', ratio: Number.POSITIVE_INFINITY };
let checks = 0;

for (const hex of SEEDS) {
  const seed = argbFromHex(hex);

  for (const variant of SCHEME_VARIANTS) {
    const palette = buildPalette(seed, variant);

    for (const isDark of [true, false]) {
      const scheme = resolveScheme(palette, isDark, { amoled: false });
      const where = `${hex} ${variant} ${isDark ? 'dark' : 'light'}`;

      for (const [fg, bg] of TEXT_PAIRS) {
        const ratio = contrastRatio(scheme[fg], scheme[bg]);
        checks += 1;
        if (ratio < worstPair.ratio) {
          worstPair = { label: `${where}: ${fg} on ${bg}`, ratio };
        }
        if (ratio < AA_BODY) {
          check(`${where}: ${fg} on ${bg}`, false, `${ratio.toFixed(2)}:1 < ${AA_BODY}`);
        }
      }

      for (const fg of ON_SURFACE_PAIRS) {
        const ratio = contrastRatio(scheme[fg], scheme.surface);
        checks += 1;
        if (ratio < worstPair.ratio) {
          worstPair = { label: `${where}: ${fg} on surface`, ratio };
        }
        if (ratio < AA_BODY) {
          check(`${where}: ${fg} on surface`, false, `${ratio.toFixed(2)}:1 < ${AA_BODY}`);
        }
      }
    }
  }
}

console.log(`  measured ${checks} pairs across ${SEEDS.length} seeds x ${SCHEME_VARIANTS.length} variants`);
check(
  `every text pair clears WCAG AA (${AA_BODY}:1)`,
  failures === 0,
  worstPair.label ? `worst: ${worstPair.label} at ${worstPair.ratio.toFixed(2)}:1` : '',
);

console.log('\n=== AMOLED ===');

const sample = resolveScheme(buildPalette(argbFromHex('#4A7FC8'), 'tonalSpot'), true, {
  amoled: true,
});
check('background is pure black', sample.background === '#000000', sample.background);
check('surface is pure black', sample.surface === '#000000', sample.surface);
check('surfaceDim is pure black', sample.surfaceDim === '#000000', sample.surfaceDim);

// The container ladder has to stay *above* black, or cards disappear into the
// background — flattening it is the obvious mistake here.
const ladder: ColorRole[] = [
  'surfaceContainerLowest',
  'surfaceContainerLow',
  'surfaceContainer',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
];
check(
  'the container ladder stays above black',
  ladder.every((role) => contrastRatio(sample[role], '#000000') > 1.0),
  ladder.map((r) => `${r}=${sample[r]}`).join(' '),
);

check(
  'body text still clears AA on pure black',
  contrastRatio(sample.onSurface, '#000000') >= AA_BODY,
  `${contrastRatio(sample.onSurface, '#000000').toFixed(2)}:1`,
);
check(
  'the derived ok/warn colours still clear AA on pure black',
  contrastRatio(sample.ok, '#000000') >= AA_BODY && contrastRatio(sample.warn, '#000000') >= AA_BODY,
  `ok ${contrastRatio(sample.ok, '#000000').toFixed(2)}:1, warn ${contrastRatio(sample.warn, '#000000').toFixed(2)}:1`,
);
check(
  'the divider stays visible against black',
  contrastRatio(sample.divider, '#000000') >= 1.4,
  `${contrastRatio(sample.divider, '#000000').toFixed(2)}:1`,
);

console.log('\n=== Non-text boundaries ===');
const light = resolveScheme(buildPalette(argbFromHex('#4A7FC8'), 'tonalSpot'), false, {});
check(
  'outline is distinguishable from the surface it borders',
  contrastRatio(light.outline, light.surface) >= AA_LARGE,
  `${contrastRatio(light.outline, light.surface).toFixed(2)}:1`,
);

/* ------------------------------------------------------------------ *
 * The CSS baseline
 * ------------------------------------------------------------------ *
 *
 * The runtime rewrites every role from the palette, but the *baseline* in
 * `index.css` is what paints the first frame and what a device without dynamic
 * colour uses forever. It is hand-written, which means nothing above this line
 * has checked it — so parse it out of the stylesheet and run the same
 * assertions over it.
 */

console.log('\n=== CSS baseline tokens ===');

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function baselineRoles(selector: string): Record<string, string> {
  const start = css.indexOf(`:root${selector} {`);
  const end = css.indexOf('}', start);
  const block = css.slice(start, end);
  const roles: Record<string, string> = {};
  for (const match of block.matchAll(/--md-sys-color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    roles[match[1]] = match[2];
  }
  return roles;
}

/** `--md-sys-color-on-ok-container` -> `onOkContainer`, to match the role names. */
function toRole(cssName: string): string {
  return cssName.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

for (const [label, selector] of [['dark', ''], ['light', "[data-theme='light']"]] as const) {
  const roles = baselineRoles(selector);
  check(`${label} baseline parsed`, Object.keys(roles).length > 40, `${Object.keys(roles).length} tokens`);

  let worst = { pair: '', ratio: Number.POSITIVE_INFINITY };
  for (const [fg, bg] of TEXT_PAIRS) {
    const f = roles[toRole(fg)];
    const b = roles[toRole(bg)];
    if (!f || !b) continue;
    const ratio = contrastRatio(f, b);
    if (ratio < worst.ratio) worst = { pair: `${fg} on ${bg}`, ratio };
    if (ratio < AA_BODY) {
      check(`${label} baseline: ${fg} on ${bg}`, false, `${ratio.toFixed(2)}:1`);
    }
  }
  for (const fg of ON_SURFACE_PAIRS) {
    const f = roles[toRole(fg)];
    const surface = roles.surface;
    if (!f || !surface) continue;
    const ratio = contrastRatio(f, surface);
    if (ratio < worst.ratio) worst = { pair: `${fg} on surface`, ratio };
    if (ratio < AA_BODY) check(`${label} baseline: ${fg} on surface`, false, `${ratio.toFixed(2)}:1`);
  }

  check(
    `${label} baseline tokens clear WCAG AA`,
    worst.ratio >= AA_BODY,
    `worst: ${worst.pair} at ${worst.ratio.toFixed(2)}:1`,
  );
}

console.log('\n=== Result ===');
if (failures === 0) {
  console.log(`  All ${checks}+ checks passed.`);
} else {
  console.log(`  ${failures} failing pair(s).`);
  process.exitCode = 1;
}

export { AA_BODY, AA_LARGE };
