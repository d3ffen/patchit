import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react';
import { installGlobalHandlers, log } from '@/diagnostics/logger';
import { AppsScreen } from '@/screens/AppsScreen';
import { LogsScreen } from '@/screens/LogsScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SourcesScreen } from '@/screens/SourcesScreen';
import { StoreProvider, useStore } from '@/state/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { NavigationBar, type Destination } from '@/ui/layout';
import { Button, EmptyState, SnackbarProvider } from '@/ui/primitives';
import { dismissTopLayer, useDismissableLayer } from '@/ui/layers';

/**
 * Shell and providers.
 *
 * Provider order matters and is not arbitrary:
 *   ThemeProvider     paints the M3 custom properties everything else styles against
 *   SnackbarProvider  needs the theme to render its inverse-surface bar
 *   StoreProvider     owns scan/sync state, so it renders inside both
 *   ErrorBoundary     wraps only the screens, keeping navigation alive through a crash
 */
/**
 * Route Android's back gesture to the topmost layer, then to the platform.
 *
 * Without this, back finishes the activity outright — `BridgeActivity` inherits
 * `AppCompatActivity`'s default and Capacitor never intercepts it, so opening an
 * app's details and pressing back dropped you to the home screen with the sheet
 * still open underneath.
 *
 * `minimizeApp` rather than `exitApp` for the empty case: back at the root of an
 * Android app should put it in the background, the same as the home gesture, not
 * kill the process.
 */
function useAndroidBackButton(): void {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    let handle: { remove: () => Promise<void> } | undefined;
    let disposed = false;

    void CapacitorApp.addListener('backButton', () => {
      if (dismissTopLayer()) return;
      void CapacitorApp.minimizeApp().catch(() => {
        // Nothing sensible to do if the platform refuses; the app stays put.
      });
    })
      .then((registered) => {
        if (disposed) void registered.remove();
        else handle = registered;
      })
      .catch((error: unknown) => {
        log.warn('shell', 'Could not register the back-button handler', error);
      });

    return () => {
      disposed = true;
      void handle?.remove();
    };
  }, []);
}

export default function App() {
  useEffect(() => installGlobalHandlers(), []);

  return (
    <ThemeProvider>
      <SnackbarProvider>
        <StoreProvider>
          <ErrorBoundary>
            <Shell />
          </ErrorBoundary>
        </StoreProvider>
      </SnackbarProvider>
    </ThemeProvider>
  );
}

function Shell() {
  const [destination, setDestination] = useState<Destination>('apps');
  const { logsOpen, setLogsOpen } = useStore();

  // The overlay is rendered here rather than inside a screen, so it registers
  // its own layer here too — otherwise back would skip past it to the platform.
  useDismissableLayer(logsOpen, () => setLogsOpen(false));
  useAndroidBackButton();

  /*
   * Three destinations, not four.
   *
   * Diagnostics used to be a tab, which put a developer tool on the same footing
   * as the two screens the app exists for. It is now a full-screen overlay
   * opened from Settings (and from a match's "open the diagnostics log" link),
   * so the navigation bar only advertises things a user came here to do.
   */
  const destinations = useMemo(
    () => [
      { id: 'apps' as const, label: 'Apps', icon: 'apps' as const },
      { id: 'sources' as const, label: 'Sources', icon: 'source' as const },
      { id: 'settings' as const, label: 'Settings', icon: 'settings' as const },
    ],
    [],
  );

  return (
    <div className="h-full">
      {destination === 'apps' && <AppsScreen />}
      {destination === 'sources' && <SourcesScreen />}
      {destination === 'settings' && <SettingsScreen />}

      <NavigationBar
        destinations={destinations}
        current={destination}
        onNavigate={setDestination}
      />

      {logsOpen && (
        <div className="fixed inset-0 z-40 bg-background">
          <LogsScreen onClose={() => setLogsOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * Render-error boundary.
 *
 * A crash in the app list must not take the log viewer with it — that is the
 * screen a user needs precisely when something is broken. So the boundary
 * replaces only the content area and leaves navigation working.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('react', `Render error: ${error.message}`, {
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex h-full flex-col bg-background pt-16">
        <EmptyState
          icon="bug-report"
          title="Something broke while rendering"
          body={this.state.error.message}
          action={
            <Button variant="tonal" icon="refresh" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        />
        <p className="md-body-small px-8 text-center text-on-surface-variant">
          The full trace is in the Logs tab.
        </p>
      </div>
    );
  }
}

export { Shell };
