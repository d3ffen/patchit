import { useEffect, useState } from 'react';
import type { SignatureVerdict, Verdict } from '@/core/compatibility';
import { useStore } from '@/state/store';
import { Icon, type IconName } from './icons';
import { Badge, cx } from './primitives';

/**
 * The small pieces of shared vocabulary: what a verdict looks like, and what an
 * app icon does while it loads.
 */

export interface VerdictPresentation {
  label: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral' | 'primary' | 'tertiary';
  icon: IconName;
  /** One-line explanation for the badge's tooltip / supporting text. */
  hint: string;
}

export const VERDICT_PRESENTATION: Record<Verdict, VerdictPresentation> = {
  supported: {
    label: 'Supported',
    tone: 'ok',
    icon: 'verified',
    hint: 'A source covers this exact build.',
  },
  experimental: {
    label: 'Experimental',
    tone: 'warn',
    icon: 'bug-report',
    hint: 'Supported, but the source marks this version experimental.',
  },
  unlisted: {
    label: 'Untested',
    tone: 'tertiary',
    icon: 'info',
    hint: 'The source covers the app but declares no versions, so nothing is verified.',
  },
  'too-new': {
    label: 'Too new',
    tone: 'error',
    icon: 'update',
    hint: 'Your build is newer than any the sources support. Patches may fail.',
  },
  'too-old': {
    label: 'Too old',
    tone: 'error',
    icon: 'download',
    hint: 'Your build is older than any the sources support.',
  },
  'no-patches': {
    label: 'No patches',
    tone: 'neutral',
    icon: 'extension',
    hint: 'No source in the registry has patches for this app.',
  },
};

export function VerdictBadge({ verdict, count }: { verdict: Verdict; count?: number }) {
  const presentation = VERDICT_PRESENTATION[verdict];
  return (
    <Badge tone={presentation.tone}>
      <Icon name={presentation.icon} size={14} />
      {presentation.label}
      {count !== undefined && count > 0 ? ` · ${count}` : ''}
    </Badge>
  );
}

export function SignatureBadge({ verdict }: { verdict: SignatureVerdict }) {
  if (verdict === 'unknown') return null;

  const map: Record<
    Exclude<SignatureVerdict, 'unknown'>,
    { label: string; tone: 'ok' | 'warn' | 'neutral'; icon: IconName }
  > = {
    verified: { label: 'Signature verified', tone: 'ok', icon: 'shield' },
    mismatch: { label: 'Signature unknown', tone: 'warn', icon: 'shield' },
    'no-certificate': { label: 'No certificate', tone: 'neutral', icon: 'shield' },
  };

  const presentation = map[verdict];
  return (
    <Badge tone={presentation.tone}>
      <Icon name={presentation.icon} size={14} />
      {presentation.label}
    </Badge>
  );
}

/**
 * App icon with a graceful three-stage fallback:
 * cached data URI -> native render -> tinted monogram.
 *
 * The monogram is not a placeholder that "should" disappear; on a device where
 * the icon genuinely cannot be read (a system package, a removed app), it is the
 * final state, and it is deliberately good-looking rather than a grey box.
 */
export function AppIcon({
  packageName,
  label,
  size = 48,
  className,
}: {
  packageName: string;
  label: string;
  size?: number;
  className?: string;
}) {
  const { loadIcon } = useStore();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    void loadIcon(packageName, 128).then((url) => {
      if (!cancelled) setDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [loadIcon, packageName]);

  const monogram = label
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase() || '?';

  /*
   * The real icon renders bare.
   *
   * It used to sit inside a rounded, tinted tile, on the assumption that app
   * icons need a backing plate. They do not: an Android launcher icon already
   * carries its own shape and background, so the tile showed up as a visible
   * rounded corner behind — and slightly inside — artwork that was already
   * complete. Two rounded rectangles where there should be one.
   *
   * The tile survives only for the monogram, which genuinely has no artwork of
   * its own and would otherwise be a letter floating in space.
   */
  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className={cx('flex-none object-contain', className)}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      className={cx('app-icon-tile bg-secondary-container text-on-secondary-container', className)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-hidden="true"
    >
      <span>{monogram}</span>
    </div>
  );
}
