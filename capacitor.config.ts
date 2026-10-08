import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.patchit',
  appName: 'PatchIt',
  webDir: 'dist',
  android: {
    // The registry lives behind GitHub raw + morphe-patches.software, both HTTPS only.
    allowMixedContent: false,
    // Keep the WebView from being torn down when Android reclaims memory: a rescan of
    // 300 packages is expensive and we would rather not repeat it on every resume.
    backgroundColor: '#141218',
  },
  server: {
    androidScheme: 'https',
  },
  plugins: {
    // Registry fetches go through the native client so conditional GETs are not
    // blocked by CORS preflight; see src/registry/http.ts for the gory detail.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
