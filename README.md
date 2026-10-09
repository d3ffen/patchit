<p align="center">
  <img src="docs/banner.png" alt="PatchIt — Morphe patch scanner for Android" width="100%">
</p>

<p align="center">
  <a href="https://github.com/d3ffen/patchit/releases/latest"><img src="https://img.shields.io/github/v/release/d3ffen/patchit?label=download&color=0B57D0" alt="Download"></a>
  <img src="https://img.shields.io/badge/platform-Android%206%2B-3DDC84?logo=android&logoColor=white" alt="Android 6+">
  <img src="https://img.shields.io/badge/Material%20You-3-0B57D0" alt="Material You 3">
  <img src="https://img.shields.io/badge/Kotlin-2.0-7F52FF?logo=kotlin&logoColor=white" alt="Kotlin">
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" alt="React 19">
  <img src="https://img.shields.io/badge/licence-GPL--3.0-blue" alt="GPL-3.0">
</p>

PatchIt scans the apps on your Android device and shows which of them the
[Morphe](https://github.com/MorpheApp/morphe-patcher) patch ecosystem can actually
patch — then hands the covering patch sources to Morphe Manager. It never patches
anything itself.

<p align="center">
  <img src="docs/screenshot-apps.webp" alt="PatchIt listing patchable apps with a verdict and patch count for each" width="45%">
  &nbsp;
  <img src="docs/screenshot-sources.webp" alt="Patch sources screen showing bundle, patch and app counts per source" width="45%">
</p>

---

## Features

- **Scans installed apps** — version name and code, split APKs, signing
  certificate, install dates, APK size.
- **Checks compatibility** — by `versionCode` first, version name second. Verdicts
  are `supported`, `experimental`, `untested`, `too new`, `too old` or
  `no patches`, computed per source.
- **Covers community patches** — ~4,200 patches across ~970 packages.
- **Works offline** — both indexes cached, plus a bundled snapshot.
- **Sets Morphe up** — sends the covering repositories to Morphe Manager through
  its real `add-source` deep link.
- **Auto-updates in-app** — finds newer versions from a banner or from Settings.
- **Material You 3** — wallpaper-derived colour, AMOLED black, themed icon.
- **Explains itself** — a 500-entry diagnostics log with every registry warning.

---

## Build

**Requirements:** Node 20+, JDK 21, Android SDK with platform 35 and build-tools 35.

```bash
npm install
npm run dev              # browser preview, no device needed
npm run build            # web bundle
npm run build:release    # web bundle without source maps or console logs
npx cap sync android
cd android && ./gradlew assembleDebug
```

Two more scripts worth knowing:

```bash
npm run verify:registry  # runs the data pipeline against the live indexes
npm run verify:theme     # measures every colour pair for WCAG contrast
```

---

## Permissions

- `QUERY_ALL_PACKAGES` — required to enumerate installed apps, which is the whole
  point of the app. Without it Android 11+ only exposes a handful of packages.
- `INTERNET` — fetching the patch indexes and checking for updates.
- `REQUEST_INSTALL_PACKAGES` — required to hand a downloaded update to Android's
  package installer. You also have to grant PatchIt "install unknown apps" before
  Android will accept it, and the installer always asks for confirmation.

## Licence

GPL-3.0. Releases are signed with a self-generated key — certificate SHA-256
`3e8c7cc9effaf575f54c61ceff035b98d52634b9e134a68f73d28074e65ed9cd`.

Not affiliated with the Morphe project. Only add patch sources you trust — a patch
source decides what ends up inside your patched apps.
