import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

/**
 * Two build modes, and the difference between them is deliberate.
 *
 *   npm run build          mode=production — debuggable
 *                          source maps on (~1.7 MB in the APK), console kept
 *   npm run build:release  mode=release    — shippable
 *                          source maps off, console and debugger stripped
 *
 * The default stays debuggable because this app has not been run on a device
 * yet, and remote-debugging the first WebView launch without source maps is
 * miserable. `build:release` is a separate command rather than an environment
 * variable on purpose: an env var is invisible at the point of use and easy to
 * forget, whereas the command you type is not.
 */
export default defineConfig(({ mode }) => {
  const isRelease = mode === 'release';
  const isProduction = mode === 'production' || isRelease;

  /**
   * This assignment has to happen before the plugin factories below, and that is
   * the whole point of it.
   *
   * Vite resolves the React environment as `process.env.NODE_ENV || mode`, so an
   * ambient `NODE_ENV=development` in the shell silently overrides the build mode
   * and swaps React for its **development** build. It does not fail; it ships —
   * 673 KB instead of 402 KB, plus dev-mode render overhead on a phone.
   *
   * Pinning it here fixes both halves: `@vitejs/plugin-react` chooses the JSX dev
   * runtime from NODE_ENV when `react()` is called, and Vite resolves React's
   * export condition from it later. The `define` below then forces the bundled
   * code down the production branch as a second line of defence.
   */
  process.env.NODE_ENV = isProduction ? 'production' : 'development';

  return {
    plugins: [react(), tailwindcss()],

    define: {
      'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
    },

    esbuild: {
      /**
       * Only for release. The app's own logging goes to the in-app ring buffer,
       * never to `console`, so nothing diagnostically useful is lost — the only
       * `console` calls in the tree are in the browser-only plugin fallbacks.
       * Keeping them in `npm run build` matters because that is the build you
       * debug with.
       */
      drop: isRelease ? ['console', 'debugger'] : [],
    },

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    build: {
      // Capacitor loads from the local filesystem, so one bundle beats aggressive
      // code splitting: a single file read instead of a waterfall on cold start.
      target: 'es2022',
      sourcemap: !isRelease,
      chunkSizeWarningLimit: 900,
    },

    server: {
      port: 5173,
    },
  };
});
