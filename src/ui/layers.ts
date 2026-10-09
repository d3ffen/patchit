import { useEffect, useRef } from 'react';

/**
 * A stack of dismissable UI layers — sheets, dialogs, full-screen overlays.
 *
 * This exists because Android's back gesture was closing the whole app. Nothing
 * in Capacitor handles back for you: `BridgeActivity` extends `AppCompatActivity`
 * and inherits its default, which finishes the activity. There is no
 * `onBackPressed` override and no `backButton` bridge event anywhere in
 * `@capacitor/android` — a WebView page has to ask for back explicitly through
 * the App plugin.
 *
 * With that event in hand, the remaining question is *what* back should close,
 * and the honest answer is "whatever the user most recently opened". Rather than
 * have every screen thread a flag up to the shell, each layer registers a
 * dismiss callback here and the handler pops the top of the stack.
 *
 * A stack rather than a boolean because layers genuinely nest: a confirmation
 * can sit on top of a sheet, and back should peel one at a time.
 */

interface Layer {
  id: number;
  dismiss: () => void;
}

const stack: Layer[] = [];
let nextId = 1;

/**
 * Register a layer. Returns the unregister function, which is what a `useEffect`
 * cleanup wants.
 */
export function pushLayer(dismiss: () => void): () => void {
  const id = nextId;
  nextId += 1;
  stack.push({ id, dismiss });

  return () => {
    const index = stack.findIndex((layer) => layer.id === id);
    if (index !== -1) stack.splice(index, 1);
  };
}

/**
 * Dismiss the most recently opened layer.
 *
 * Returns false when nothing is open, which is the caller's signal to fall
 * through to the platform default (minimising the app) rather than swallowing
 * the gesture — an app that never closes is a worse bug than one that closes
 * too eagerly.
 */
export function dismissTopLayer(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

export function openLayerCount(): number {
  return stack.length;
}

/**
 * Register a layer for as long as `active` is true.
 *
 * The callback is held in a ref so an inline arrow function — which is what
 * every call site passes — does not re-register the layer on every render and
 * shuffle it to the top of the stack.
 */
export function useDismissableLayer(active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  latest.current = dismiss;

  useEffect(() => {
    if (!active) return;
    return pushLayer(() => latest.current());
  }, [active]);
}
