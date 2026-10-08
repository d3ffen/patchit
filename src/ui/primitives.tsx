import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './icons';

/**
 * Material 3 component primitives.
 *
 * Hand-rolled rather than pulled from a component library, for two reasons:
 * MUI is 300 KB before tree-shaking and ships its own theming system that would
 * fight the dynamic-colour CSS variables, and M3's spec is small enough that the
 * twelve components this app needs fit in one reviewable file.
 *
 * The M3 details that are easy to skip and very visible when missing:
 *  - state layers are `currentColor` overlays, not `:hover { opacity }` on the
 *    whole element (which would fade the label too),
 *  - disabled states use 12% on-surface for the container and 38% for the label,
 *  - elevation is a token, never an ad-hoc box-shadow.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ *
 * Button
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'filled' | 'tonal' | 'elevated' | 'outlined' | 'text' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  filled: 'bg-primary text-on-primary hover:shadow-e1',
  tonal: 'bg-secondary-container text-on-secondary-container hover:shadow-e1',
  elevated: 'bg-surface-container-low text-primary shadow-e1 hover:shadow-e2',
  outlined: 'border border-outline text-primary bg-transparent',
  text: 'text-primary bg-transparent',
  danger: 'bg-error text-on-error',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: IconName;
  trailingIcon?: IconName;
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'filled',
    icon,
    trailingIcon,
    loading = false,
    fullWidth = false,
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const spinner = loading;

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        'state-layer md-label-large inline-flex h-10 items-center justify-center gap-2 rounded-full px-6',
        'transition-shadow duration-150 ease-standard select-none',
        'disabled:opacity-40 disabled:shadow-none',
        variant === 'text' ? 'px-3' : undefined,
        BUTTON_VARIANTS[variant],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {spinner ? (
        <CircularProgress size={18} />
      ) : (
        icon && <Icon name={icon} size={18} />
      )}
      {children}
      {trailingIcon && !spinner && <Icon name={trailingIcon} size={18} />}
    </button>
  );
});

/* ------------------------------------------------------------------ *
 * IconButton
 * ------------------------------------------------------------------ */

export type IconButtonVariant = 'standard' | 'filled' | 'tonal' | 'outlined';

const ICON_BUTTON_VARIANTS: Record<IconButtonVariant, string> = {
  standard: 'text-on-surface-variant bg-transparent',
  filled: 'bg-primary text-on-primary',
  tonal: 'bg-secondary-container text-on-secondary-container',
  outlined: 'border border-outline text-on-surface-variant',
};

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  variant?: IconButtonVariant;
  size?: number;
  selected?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'standard', size = 24, selected = false, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'state-layer inline-flex size-10 flex-none items-center justify-center rounded-full',
        'transition-colors duration-150 ease-standard disabled:opacity-40',
        ICON_BUTTON_VARIANTS[variant],
        selected && variant === 'standard' && 'text-primary',
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
});

/* ------------------------------------------------------------------ *
 * FAB — M3's primary action affordance
 * ------------------------------------------------------------------ */

export type FabSize = 'small' | 'medium' | 'large';
export type FabVariant = 'primary' | 'secondary' | 'tertiary' | 'surface';

const FAB_VARIANTS: Record<FabVariant, string> = {
  primary: 'bg-primary-container text-on-primary-container',
  secondary: 'bg-secondary-container text-on-secondary-container',
  tertiary: 'bg-tertiary-container text-on-tertiary-container',
  surface: 'bg-surface-container-high text-primary',
};

const FAB_SIZES: Record<FabSize, { box: string; icon: number }> = {
  small: { box: 'size-10 rounded-md', icon: 20 },
  medium: { box: 'size-14 rounded-xl', icon: 24 },
  large: { box: 'size-24 rounded-xl', icon: 36 },
};

export interface FabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: FabSize;
  variant?: FabVariant;
  /** M3 extended FAB: icon plus a text label. */
  extended?: boolean;
}

export function Fab({
  icon,
  label,
  size = 'medium',
  variant = 'primary',
  extended = false,
  className,
  ...rest
}: FabProps) {
  const spec = FAB_SIZES[size];

  return (
    <button
      type="button"
      aria-label={label}
      className={cx(
        'state-layer inline-flex items-center justify-center gap-3 shadow-e3',
        'transition-[box-shadow,transform] duration-200 ease-emphasized active:scale-95',
        extended ? 'h-14 rounded-xl px-5' : spec.box,
        FAB_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={extended ? 24 : spec.icon} />
      {extended && <span className="md-label-large">{label}</span>}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

export type CardVariant = 'elevated' | 'filled' | 'outlined';

/**
 * Semantic fills that *replace* a variant's background rather than fighting it.
 *
 * This prop exists because of a real bug. The verdict card used to be
 * `variant="filled"` with `className="bg-ok-container"`, which put two
 * background utilities on one element — and Tailwind does not resolve that by
 * the order they appear in the class string, it resolves by the order they
 * appear in the generated stylesheet. `bg-surface-container-highest` won, so a
 * dark grey card ended up carrying `text-on-ok-container`, dark green on dark
 * grey, at roughly 1.2:1. Nothing in the type system or the build noticed.
 *
 * Passing the fill in as a prop means only one background class is ever emitted.
 */
export type CardTone = 'ok' | 'warn' | 'error' | 'primary' | 'tertiary' | 'surface';

const TONE_FILLS: Record<CardTone, string> = {
  ok: 'bg-ok-container text-on-ok-container',
  warn: 'bg-warn-container text-on-warn-container',
  error: 'bg-error-container text-on-error-container',
  primary: 'bg-primary-container text-on-primary-container',
  tertiary: 'bg-tertiary-container text-on-tertiary-container',
  surface: 'bg-surface-container-high',
};

/**
 * The spec's three card variants, verbatim.
 *
 *  - Elevated: shadow separation over a level-1 container fill.
 *  - Filled: a flat `surface_variant` overlay, completely shadowless.
 *  - Outlined: an `outline` hairline, no shadow.
 *
 * Note `outline`, not `outline-variant` — M3 reserves the variant tone for
 * internal seams and uses the full `outline` for a component's own boundary.
 */
const CARD_VARIANTS: Record<CardVariant, { fill: string; extra: string }> = {
  elevated: { fill: 'bg-surface-container-low', extra: 'shadow-e1' },
  filled: { fill: 'bg-surface-variant', extra: '' },
  outlined: { fill: 'bg-surface', extra: 'border border-outline' },
};

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  /** Replaces the variant's fill with a semantic one. */
  tone?: CardTone;
  /** Adds an M3 state layer; use when the whole card is tappable. */
  interactive?: boolean;
}

export function Card({
  variant = 'filled',
  tone,
  interactive = false,
  className,
  ...rest
}: CardProps) {
  const spec = CARD_VARIANTS[variant];

  return (
    <div
      className={cx(
        // Medium (12px). Cards are not FABs; the extra-large corner belongs to
        // the components that actually float.
        'rounded-md',
        tone ? TONE_FILLS[tone] : spec.fill,
        spec.extra,
        interactive && 'state-layer cursor-pointer transition-shadow hover:shadow-e1',
        className,
      )}
      {...rest}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Chip
 * ------------------------------------------------------------------ */

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: IconName;
  selected?: boolean;
  /** Renders a trailing check when selected, per M3 filter chips. */
  checkOnSelect?: boolean;
  /**
   * Marks this chip as the notable one among its siblings — the recommended
   * version, say — without selecting it.
   *
   * A prop rather than `className="text-primary"`, for the same reason `Card`
   * takes a `tone`: two colour utilities on one element are resolved by
   * Tailwind's stylesheet order, not by the order they were written, so the
   * override silently loses about half the time.
   */
  accent?: boolean;
}

export function Chip({
  icon,
  selected = false,
  checkOnSelect = true,
  accent = false,
  className,
  children,
  ...rest
}: ChipProps) {
  const inactive = accent
    ? 'border border-primary text-primary'
    : 'border border-outline-variant text-on-surface-variant';

  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        'state-layer md-label-large inline-flex h-8 flex-none items-center gap-2 rounded-sm px-3',
        'transition-colors duration-150 ease-standard',
        selected ? 'bg-secondary-container text-on-secondary-container' : inactive,
        className,
      )}
      {...rest}
    >
      {selected && checkOnSelect ? (
        <Icon name="check" size={18} />
      ) : (
        icon && <Icon name={icon} size={18} />
      )}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Switch
 * ------------------------------------------------------------------ */

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({ checked, onCheckedChange, label, disabled = false, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        'md-switch relative inline-flex flex-none items-center rounded-full',
        'transition-colors duration-200 ease-emphasized disabled:opacity-40',
        checked ? 'bg-primary' : 'border-2 border-outline bg-surface-container-highest',
        className,
      )}
    >
      {/* The handle grows when checked and when pressed — M3's "squish". */}
      <span
        className={cx(
          'md-switch-knob absolute grid place-items-center rounded-full',
          'transition-all duration-200 ease-emphasized',
          checked ? 'md-switch-knob-on bg-on-primary' : 'md-switch-knob-off bg-outline',
        )}
      >
        {checked && <Icon name="check" size={14} className="text-primary" />}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

export function CircularProgress({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 44 44"
      width={size}
      height={size}
      className={cx('animate-spin', className)}
      style={{ animationDuration: '1.4s' }}
      role="progressbar"
      aria-label="Loading"
    >
      <circle cx="22" cy="22" r="18" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" />
      <circle
        cx="22"
        cy="22"
        r="18"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray="30 200"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Divider / Badge
 * ------------------------------------------------------------------ */

/**
 * Hairline between rows.
 *
 * Uses the `divider` role rather than `outline-variant`: the derived role is the
 * outline pulled 18% toward the accent, so the rule picks up the wallpaper
 * palette instead of staying grey and detached beside it. Drawn at 60% opacity,
 * again following Morphe Manager, so it reads as a seam rather than a border.
 */
export function Divider({ className, inset = false }: { className?: string; inset?: boolean }) {
  return <div className={cx('h-px bg-divider/60', inset && 'ml-16', className)} />;
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'warn' | 'error' | 'primary' | 'tertiary';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-container-highest text-on-surface-variant',
    ok: 'bg-ok-container text-on-ok-container',
    warn: 'bg-warn-container text-on-warn-container',
    error: 'bg-error-container text-on-error-container',
    primary: 'bg-primary-container text-on-primary-container',
    tertiary: 'bg-tertiary-container text-on-tertiary-container',
  };

  return (
    <span
      className={cx(
        'md-label-medium inline-flex items-center gap-1 rounded-sm px-2 py-0.5',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * TextField — M3 outlined, the variant that survives a dark wallpaper
 * ------------------------------------------------------------------ */

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  leadingIcon?: IconName;
  trailing?: ReactNode;
  error?: string | null;
  helper?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, leadingIcon, trailing, error, helper, className, id, ...rest },
  ref,
) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const helperId = `${fieldId}-helper`;

  return (
    <div className={cx('w-full', className)}>
      <div
        className={cx(
          'relative flex h-14 items-center gap-3 rounded-xs border px-4 transition-colors duration-150',
          'bg-surface-container-lowest',
          error
            ? 'border-error'
            : 'border-outline focus-within:border-primary focus-within:border-2',
        )}
      >
        {leadingIcon && <Icon name={leadingIcon} size={20} className="flex-none text-on-surface-variant" />}
        <input
          ref={ref}
          id={fieldId}
          aria-describedby={helper || error ? helperId : undefined}
          aria-invalid={Boolean(error)}
          placeholder=" "
          className="peer md-body-large h-full w-full min-w-0 bg-transparent text-on-surface outline-none placeholder:text-transparent"
          {...rest}
        />
        {/*
          The floating label is driven by `:placeholder-shown` rather than React
          state so it stays in step with autofill and programmatic value changes.
          `placeholder=" "` above is what makes that selector usable.
        */}
        <label
          htmlFor={fieldId}
          className={cx(
            'pointer-events-none absolute origin-left transition-all duration-150 ease-standard',
            'left-4 top-1/2 -translate-y-1/2 bg-surface-container-lowest px-1 md-body-large text-on-surface-variant',
            'peer-focus:top-0 peer-focus:md-body-small',
            leadingIcon && 'peer-focus:left-3',
            'peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:md-body-small',
            leadingIcon && 'left-12',
            error && 'text-error peer-focus:text-error',
            !error && 'peer-focus:text-primary',
          )}
        >
          {label}
        </label>
        {trailing}
      </div>
      {(helper || error) && (
        <p
          id={helperId}
          className={cx('md-body-small mt-1 px-4', error ? 'text-error' : 'text-on-surface-variant')}
        >
          {error || helper}
        </p>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * Search bar — M3's own component, not a text field in disguise
 * ------------------------------------------------------------------ */

export interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  trailing?: ReactNode;
  className?: string;
}

/**
 * 56dp, full radius, `surface_container_high` fill.
 *
 * The app list used an outlined text field here, which is the M3 *input* shape.
 * A search bar is its own component in M3 — pill-shaped, filled, with the
 * magnifier as a permanent leading affordance — and using the right one is most
 * of what makes a screen read as Material.
 */
export function SearchBar({ value, onChange, placeholder, trailing, className }: SearchBarProps) {
  return (
    <div className={cx('md-search-bar flex items-center gap-3 px-4', className)}>
      <Icon name="search" size={24} className="flex-none text-on-surface-variant" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="md-body-large h-full w-full min-w-0 bg-transparent text-on-surface outline-none placeholder:text-on-surface-variant"
      />
      {trailing}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * List row
 * ------------------------------------------------------------------ */

export interface ListItemProps {
  leading?: ReactNode;
  headline: ReactNode;
  supporting?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  className?: string;
}

export function ListItem({
  leading,
  headline,
  supporting,
  trailing,
  onClick,
  className,
}: ListItemProps) {
  const content = (
    <>
      {leading}
      <div className="min-w-0 flex-1">
        <div className="md-body-large truncate text-on-surface">{headline}</div>
        {supporting && <div className="md-body-medium mt-0.5 text-on-surface-variant">{supporting}</div>}
      </div>
      {trailing}
    </>
  );

  const classes = cx(
    // 72dp: the spec's two-line list item height, which is what every row here is.
    'md-list-item flex w-full items-center gap-4 px-4 py-3 text-left',
    onClick && 'state-layer cursor-pointer',
    className,
  );

  // Two explicit branches rather than a dynamic tag: a `<div>` with a `type`
  // attribute is invalid HTML, and a polymorphic component would cost more
  // type gymnastics than the two lines it saves.
  // Two explicit branches rather than a polymorphic component: the props are a
  // small closed set, so there is nothing to forward and nothing to get wrong.
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {content}
      </button>
    );
  }

  return <div className={classes}>{content}</div>;
}

/* ------------------------------------------------------------------ *
 * Segmented button — M3's replacement for tabs on small screens
 * ------------------------------------------------------------------ */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cx('flex overflow-hidden rounded-full border border-outline', className)}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cx(
              'state-layer md-label-large flex h-10 flex-1 items-center justify-center gap-2 transition-colors',
              index > 0 && 'border-l border-outline',
              selected
                ? 'bg-secondary-container text-on-secondary-container'
                : 'bg-transparent text-on-surface',
            )}
          >
            {selected ? <Icon name="check" size={18} /> : option.icon && <Icon name={option.icon} size={18} />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Dialog — M3 basic dialog
 * ------------------------------------------------------------------ */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  icon?: IconName;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}

export function Dialog({ open, onClose, icon, title, children, actions }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Focus the dialog so screen readers and Escape both land in the right place.
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-6">
      <div
        className="absolute inset-0 bg-scrim/50 animate-enter"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="animate-enter relative w-full max-w-sm rounded-md bg-surface-container-high p-6 outline-none"
      >
        {icon && (
          <div className="mb-4 flex justify-center text-secondary">
            <Icon name={icon} size={24} />
          </div>
        )}
        <h2 className="md-headline-small text-center text-on-surface">{title}</h2>
        {children && <div className="md-body-medium mt-4 text-on-surface-variant">{children}</div>}
        {actions && <div className="mt-6 flex justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * BottomSheet — M3 modal bottom sheet with a drag handle
 * ------------------------------------------------------------------ */

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  fullHeight = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  fullHeight?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startY: number; offset: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = { startY: event.clientY, offset: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const offset = Math.max(0, event.clientY - dragState.current.startY);
    dragState.current.offset = offset;
    if (scrollRef.current) scrollRef.current.style.transform = `translateY(${offset}px)`;
  }, []);

  const onPointerUp = useCallback(() => {
    const dragged = dragState.current?.offset ?? 0;
    dragState.current = null;
    if (scrollRef.current) {
      scrollRef.current.style.transform = '';
    }
    // A drag of more than 120px is a dismissal, not an overshoot.
    if (dragged > 120) onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div className="absolute inset-0 bg-scrim/50" onClick={onClose} aria-hidden="true" />
      <div
        ref={scrollRef}
        className={cx(
          // Large (16px) top corners, per the shape scale's sheet role.
          'md-sheet animate-sheet-up relative flex flex-col rounded-t-lg bg-surface-container-low',
          fullHeight ? 'md-sheet-tall' : 'md-sheet-auto',
        )}
      >
        <div
          className="flex flex-none cursor-grab touch-none flex-col items-center pt-2 active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <div className="h-1 w-8 rounded-full bg-on-surface-variant/40" />
          {title && (
            <h2 className="md-title-large w-full px-6 pb-2 pt-4 text-on-surface">{title}</h2>
          )}
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(var(--safe-bottom)+16px)]">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Snackbar
 * ------------------------------------------------------------------ */

interface SnackbarState {
  message: string;
  action?: { label: string; run: () => void };
}

const SnackbarContext = createContext<{ show: (state: SnackbarState) => void } | null>(null);

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SnackbarState | null>(null);
  const timer = useRef<number | null>(null);

  const show = useCallback((next: SnackbarState) => {
    setState(next);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState(null), next.action ? 6000 : 3500);
  }, []);

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <SnackbarContext.Provider value={{ show }}>
      {children}
      {state && (
        <div
          role="status"
          aria-live="polite"
          className="animate-enter fixed inset-x-4 bottom-[calc(var(--app-nav-height)+var(--safe-bottom)+8px)] z-50 flex items-center gap-4 rounded-xs bg-inverse-surface px-4 py-3 text-inverse-on-surface shadow-e3"
        >
          <span className="md-body-medium flex-1">{state.message}</span>
          {state.action && (
            <button
              type="button"
              onClick={() => {
                state.action?.run();
                setState(null);
              }}
              className="md-label-large text-inverse-primary"
            >
              {state.action.label}
            </button>
          )}
        </div>
      )}
    </SnackbarContext.Provider>
  );
}

export function useSnackbar() {
  const context = useContext(SnackbarContext);
  if (!context) throw new Error('useSnackbar must be used inside <SnackbarProvider>');
  return context;
}

/* ------------------------------------------------------------------ *
 * Empty state
 * ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="animate-enter flex flex-col items-center px-8 py-16 text-center">
      <div className="mb-4 grid size-16 place-items-center rounded-full bg-surface-container-high text-on-surface-variant">
        <Icon name={icon} size={28} />
      </div>
      <h3 className="md-title-medium text-on-surface">{title}</h3>
      {body && <p className="md-body-medium mt-2 max-w-xs text-on-surface-variant">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
