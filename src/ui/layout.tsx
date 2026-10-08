import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { CircularProgress, cx, IconButton } from './primitives';

/**
 * Navigation chrome.
 *
 * The M3 navigation bar is a fixed 80dp bar with an *active indicator* — the
 * rounded pill behind the selected icon — rather than a colour change on the
 * icon alone. It reads correctly against a dynamic palette, where "selected
 * primary" can end up close to the surface colour.
 *
 * Everything here respects the safe-area insets, because the scanner is meant
 * to be used one-handed on a device with a gesture bar.
 */

export type Destination = 'apps' | 'sources' | 'logs' | 'settings';

export interface NavigationDestination {
  id: Destination;
  label: string;
  icon: IconName;
  /** Rendered as a dot on the icon; used for unread warnings in the log. */
  badge?: number;
}

export function NavigationBar({
  destinations,
  current,
  onNavigate,
}: {
  destinations: NavigationDestination[];
  current: Destination;
  onNavigate: (destination: Destination) => void;
}) {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex border-t border-outline-variant/40 bg-surface-container"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      {destinations.map((destination) => {
        const selected = destination.id === current;
        return (
          <button
            key={destination.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onNavigate(destination.id)}
            className="state-layer flex flex-1 flex-col items-center gap-1 py-3"
          >
            <span
              className={cx(
                'relative grid h-8 w-16 place-items-center rounded-full transition-colors duration-200 ease-emphasized',
                selected ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant',
              )}
            >
              <Icon name={destination.icon} size={24} />
              {destination.badge ? (
                <span className="md-label-small absolute right-3 top-1 grid min-w-4 place-items-center rounded-full bg-error px-1 text-on-error">
                  {destination.badge > 99 ? '99+' : destination.badge}
                </span>
              ) : null}
            </span>
            <span
              className={cx(
                'md-label-medium',
                selected ? 'text-on-surface' : 'text-on-surface-variant',
              )}
            >
              {destination.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export interface TopAppBarProps {
  title: string;
  /** A back arrow, when set; otherwise the leading slot is free for an avatar. */
  onBack?: () => void;
  leading?: ReactNode;
  actions?: ReactNode;
  /** Renders on a surface container with a shadow once content scrolls under it. */
  elevated?: boolean;
  subtitle?: ReactNode;
  /** Replaces the title row with a search field. */
  search?: ReactNode;
}

export function TopAppBar({
  title,
  onBack,
  leading,
  actions,
  elevated = false,
  subtitle,
  search,
}: TopAppBarProps) {
  return (
    <header
      className={cx(
        'sticky top-0 z-20 flex flex-col bg-surface transition-shadow duration-200',
        elevated && 'shadow-e2',
      )}
      style={{ paddingTop: 'var(--safe-top)' }}
    >
      <div className="flex h-16 items-center gap-1 px-1">
        {onBack ? (
          <IconButton icon="arrow-back" label="Back" onClick={onBack} />
        ) : (
          leading ?? <div className="w-4" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="md-title-large truncate px-2 text-on-surface">{title}</h1>
          {subtitle && <div className="md-body-small truncate px-2 text-on-surface-variant">{subtitle}</div>}
        </div>
        <div className="flex flex-none items-center gap-1 pr-1">{actions}</div>
      </div>
      {search && <div className="px-4 pb-3">{search}</div>}
    </header>
  );
}

/**
 * The scroll container. Owns the padding that keeps the last list row clear of
 * the navigation bar and the floating action button.
 */
export function Scaffold({
  appBar,
  children,
  fab,
  className,
}: {
  appBar?: ReactNode;
  children: ReactNode;
  fab?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex h-full flex-col bg-background', className)}>
      {appBar}
      <main
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        style={{
          paddingBottom: 'calc(var(--app-nav-height) + var(--safe-bottom) + 88px)',
        }}
      >
        {children}
      </main>
      {fab && (
        <div
          className="pointer-events-none fixed inset-x-0 z-30 flex justify-end px-4"
          style={{ bottom: 'calc(var(--app-nav-height) + var(--safe-bottom) + 16px)' }}
        >
          <div className="pointer-events-auto">{fab}</div>
        </div>
      )}
    </div>
  );
}

/** A section heading inside a screen: M3 title-small in the primary colour. */
export function SectionHeader({
  children,
  trailing,
  className,
}: {
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-center justify-between px-4 pb-2 pt-6', className)}>
      <h2 className="md-title-small text-primary">{children}</h2>
      {trailing}
    </div>
  );
}

/** Indeterminate sync/scan banner shown under the app bar while work is running. */
export function ActivityBar({ label, onCancel }: { label: string; onCancel?: () => void }) {
  return (
    <div className="flex items-center gap-3 bg-secondary-container px-4 py-2 text-on-secondary-container">
      <CircularProgress size={16} />
      <span className="md-body-medium flex-1 truncate">{label}</span>
      {onCancel && <IconButton icon="close" label="Cancel" size={18} onClick={onCancel} />}
    </div>
  );
}
