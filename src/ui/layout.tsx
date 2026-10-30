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
      /*
       * One floating dock, not three separate pills.
       *
       * This is the Morphe Manager navigation shape: a single rounded container
       * with a hairline, and the selected destination carried by a filled pill
       * *inside* it. Three detached pills read as three unrelated buttons; one
       * container reads as a navigation bar with a current location.
       *
       * The geometry lives in `.md-nav-bar` / `.md-nav-item` in index.css so the
       * safe-area inset and the label size are defined once.
       */
      className="md-nav-bar fixed z-30 flex"
    >
      {destinations.map((destination) => {
        const selected = destination.id === current;
        return (
          <button
            key={destination.id}
            type="button"
            aria-label={destination.label}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onNavigate(destination.id)}
            className={cx(
              'md-nav-item state-layer relative flex flex-1 items-center justify-center gap-2',
              selected ? 'md-nav-item-active' : 'text-on-surface-variant',
            )}
          >
            <Icon name={destination.icon} size={22} />
            <span className="md-label-large">{destination.label}</span>
            {destination.badge ? (
              <span className="md-label-small absolute right-3 top-1 grid min-w-4 place-items-center rounded-full bg-error px-1 text-on-error">
                {destination.badge > 99 ? '99+' : destination.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

export interface TopAppBarProps {
  /** Usually a string; the Apps screen passes the gradient wordmark element. */
  title: ReactNode;
  /** Extra classes for the title element (size/colour overrides). */
  titleClassName?: string;
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
  titleClassName,
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
        'sticky top-0 z-20 flex flex-col bg-surface/85 backdrop-blur-xl transition-shadow duration-200',
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
          <h1 className={cx('md-title-large truncate px-2 text-on-surface', titleClassName)}>
            {title}
          </h1>
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
    <div className={cx('flex h-full flex-col bg-transparent', className)}>
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
