# AGENTS.md — context for AI sessions working on this repo

You are working on **PatchIt**, an Android app. This file is the orientation
document: read it before changing anything. The "Hard constraints" section is the
important part — those are traps that have already cost real debugging time, and
every one of them fails *silently*.

---

## What this is

PatchIt scans the packages installed on an Android device and reports which of
them the [Morphe](https://github.com/MorpheApp/morphe-patcher) patch ecosystem can
actually patch, then hands the covering patch **sources** to Morphe Manager.

**It never patches anything itself.** It answers *whether* and *by whom*; Morphe
decides *how*. Do not add code that patches or installs apps.

- Public repo: `github.com/d3ffen/patchit`
- Current release: **v1.0.2** (self-signed APK on GitHub Releases + in-app updater)
- Licence: GPL-3.0

---

## Stack

| Layer | Technology |
|---|---|
| UI | React 19, TypeScript 5.7 (strict), Tailwind CSS 4 (CSS-first `@theme`) |
| Shell | Capacitor 7 (WebView + native bridge) |
| Native | Kotlin 2.0, registered in `MainActivity` |
| Colour | `@material/material-color-utilities` (Google's HCT algorithms) |
| Storage | IndexedDB via `idb` |
| Build | Vite 6, Gradle 8.11.1, AGP 8.7.2 |

---

## Commands

```bash
npm install                  # .npmrc pins include=dev — see constraints
npm run dev                  # browser preview, fake packages, no device needed
npm run build                # debuggable: source maps + console kept
npm run build:release        # shippable: no maps, console/debugger stripped
npm run typecheck

npm run verify:registry      # pipeline vs the LIVE indexes (network)
npm run verify:theme         # 2520 colour pairs vs WCAG AA
npm run build:seed           # refresh public/bundled-registry.seed

npx cap sync android
cd android && ./gradlew assembleDebug
```

`npm run dev` renders the entire UI against `src/native/web.ts` with eight fake
installed packages. Use it — a Gradle build plus install is minutes, this is
milliseconds.

---

## Architecture

```
WebView (React)
  screens/ ─► ui/ ─► theme/
      └────┬─────┘
           ▼
        state/            one store; memoises the expensive derivations
      ┌────┴────┐
      ▼         ▼
   core/     registry/      verdict engine · fetch→parse→normalise→snapshot
      │         │
      └── native/ ──┐       typed plugin handles + browser fallbacks
                    ▼
Kotlin (Capacitor plugins)
  AppScanner · SystemTheme · MorpheBridge · AppUpdater
```

Measured import graph (may be stale — re-derive if it matters):

```
screens  → ui (18)  core (6)  state (5)  registry (2)  theme (2)  native (1)
state    → registry (6)  native (3)  core (1)
core     → native (3)  registry (2)
registry → diagnostics (1)
native   → core (1)
```

Acyclic at module level. **Known wart:** `core/` is documented as "pure logic, no
platform" but `core/morphe.ts` imports the native bridge to fire the add-source
intent. It is orchestration, not pure logic; moving it out would make the folder
comment honest.

### Module responsibilities

| Module | Lines | Owns |
|---|---|---|
| `src/screens/` | ~2,000 | Apps · Detail · Sources · Settings · Logs |
| `src/ui/` | ~1,900 | M3 primitives, inline icons, nav chrome, layer registry, updater UI |
| `src/registry/` | ~1,750 | Schema, defensive parsers, source resolution, HTTP, IndexedDB, seed, sync |
| `src/core/` | ~770 | Version comparison, verdict engine, Morphe hand-off |
| `src/native/` | ~730 | Plugin contracts, updater, browser fallbacks |
| `src/theme/` | ~690 | Palette engine, WCAG contrast maths, provider |
| `src/state/` | ~570 | Single store |
| `src/diagnostics/` | ~150 | Ring-buffer logger + global error capture |

### Kotlin plugins — `android/app/src/main/java/app/patchit/`

Split by **permission and lifecycle**, not convenience. A theme read must not drag
`QUERY_ALL_PACKAGES` along with it.

- `AppScannerPlugin.kt` (~500) — `PackageManager` enumeration on `Dispatchers.IO`,
  icon rendering with an `LruCache`, app info / store / uninstall-free actions
- `SystemThemePlugin.kt` (~120) — Monet tonal palettes, OS theme-change events
- `MorpheBridgePlugin.kt` (~330) — `add-source` deep links, Morphe discovery
- `AppUpdaterPlugin.kt` (~250) — streams release APK to `cacheDir`, hands it to the
  system installer via FileProvider

---

## Hard constraints

Each of these has already caused a real bug. All of them fail silently.

**1. Assets must not be named `*.gz`.** AAPT2 decompresses any asset ending in
`.gz` at package time and strips the extension. Shipping
`bundled-registry.json.gz` puts a 4.8 MB `bundled-registry.json` in the APK and
makes the fetch 404 — the seed module degrades to "no seed", so nothing looks
broken. It is `public/bundled-registry.seed` for this reason. The bytes are still
gzip.

**2. Never put two colour utilities on one element.** `Card` and `Chip` take their
fill as a prop (`tone`, `accent`) rather than through `className`. Passing
`className="bg-ok-container"` to a `variant="filled"` card emits two background
utilities, and **Tailwind resolves that by stylesheet order, not by the order you
wrote it**. A dark grey card carried dark green text at ~1.2:1 and nothing in the
type system or the build noticed.

**3. Do not drive `transform` with a CSS animation on an element you also
transform from JS.** `animation: ... both` keeps owning the property after it
finishes, and CSS animations outrank inline styles — so every drag write was
discarded and the sheet handle was inert. The bottom sheet uses a *transition* and
one owner.

**4. Android back is not handled by Capacitor.** There is no `onBackPressed`
override in `BridgeActivity` and no `backButton` bridge event anywhere in
`@capacitor/android`. A page must subscribe through `@capacitor/app`. The layer
registry in `src/ui/layers.ts` dismisses the topmost sheet; with no layers open
the handler calls `minimizeApp()`, not `exitApp()`.

**5. `NODE_ENV` must not leak into the build.** Vite resolves React as
`process.env.NODE_ENV || mode`, so an ambient `NODE_ENV=development` silently
ships React's *development* build — 673 KB instead of 402 KB. `vite.config.ts`
pins it. `.npmrc` pins `include=dev` for the same class of reason.

**6. Re-validate the APK after building, every time.** Check that the asset name
survived, that `debuggable` is absent from a release build, and that permissions
are what you expect:

```bash
apkanalyzer apk summary <apk>
apkanalyzer manifest print <apk> | grep uses-permission
unzip -l <apk> | grep bundled-registry
```

**7. A signature change means an uninstall.** PatchIt releases are signed with a
self-generated key; debug builds use the Android debug key. `adb install -r`
across those fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` and — critically —
**the deploy looks like it succeeded if you pipe the output through `tail`**. Read
the exit code.

---

## Release process

Keystore lives **outside the repo** (never commit it):

```
~/Downloads/.patchit-signing/patchit-release.jks    (chmod 600)
~/Downloads/.patchit-signing/password.txt           (chmod 600)
```

Certificate SHA-256: `3e8c7cc9effaf575f54c61ceff035b98d52634b9e134a68f73d28074e65ed9cd`

There is no `signingConfig` in Gradle — signing is a post-build step, so no
credentials are in the tree:

```bash
# 1. bump versionCode/versionName in android/app/build.gradle
npm run build:release && npx cap sync android
cd android && ./gradlew assembleRelease
BT=~/Downloads/.android-sdk/build-tools/35.0.0
cd app/build/outputs/apk/release
"$BT/zipalign" -p -f 4 app-release-unsigned.apk aligned.apk
"$BT/apksigner" sign --ks ~/Downloads/.patchit-signing/patchit-release.jks \
  --ks-pass "pass:$(cat ~/Downloads/.patchit-signing/password.txt)" \
  --ks-key-alias patchit --out patchit-X.Y.Z.apk aligned.apk
gh release create vX.Y.Z patchit-X.Y.Z.apk --title "PatchIt X.Y.Z" --notes-file notes.md --latest
```

**Losing that keystore means the app can never be updated again.** R8 is
deliberately off (`minifyEnabled false`) because minification is untested against
Capacitor's reflective plugin loading.

---

## Verification is not optional

Two suites exist and both must pass before a release:

- `verify:registry` — runs `core/` and `registry/` under Node against the **live**
  endpoints. Version-comparison edge cases, parsing both real documents, verdicts
  for known apps, and a simulated cold start from the bundled seed.
- `verify:theme` — 2520 text/background pairs across 7 seeds × 9 variants × both
  schemes, held to WCAG AA, plus the AMOLED overrides, plus the two hand-written
  baseline blocks parsed out of `src/index.css`.

Run `npm run typecheck` too. For anything touching the bridge or the APK, the
only real check is installing on a device.

### Toolchain on this machine

Not on `PATH` by default:

```bash
source ~/Downloads/.toolchain/env.sh    # JDK 21, ANDROID_HOME, GRADLE_USER_HOME
```

---

## Design rules

- **Tokens, not values.** Palette, type scale, shape scale and elevation all resolve
  through CSS custom properties written by `src/theme/m3.ts`. No component carries
  an absolute measurement — a switch track is 52×32 because `.md-switch` says so,
  not because some JSX says `w-[52px]`.
- **Shape by role:** cards/banners/dialogs 12px (`rounded-md`), chips/badges 8px,
  sheets 16px (`rounded-lg`), FABs 28px (`rounded-xl`), buttons/search full.
- **Type stays inside the 15-level M3 scale.** No arbitrary `text-[11px]`, no
  `font-mono` on UI copy (it survives only in the two `<pre>` code blocks).
- **`on-*` colours are derived, never picked.** `resolveScheme()` measures them
  with WCAG contrast *after* the AMOLED override, because they must be measured
  against the surface they actually sit on.
- Comments explain **why**, not what. If a line looks odd, the comment above it
  should say what breaks without it.

---

## Current state and open items

**Verified on hardware:** scan, icons, live registry sync, verdicts, dynamic
colour, AMOLED, launcher icon, the add-source hand-off, back gesture, pull-to-dismiss.

**Not verified:** the updater's download-and-install hand-off has never been
watched completing end to end.

**Known gaps:**

- **"Already patched" detection is missing** — it was in the original brief.
  Detectable: a patched app is re-signed with a certificate the bundle does not
  declare (we already surface `signatureSha256` as a warning), and Morphe's
  "Change package name" patch appends `.morphe` to the package id.
- **Adding a source adds every app it covers.** This is inherent — `add-source`
  registers a *repository*, and the link accepts only `github`, `gitlab`, `name`.
  Morphe's own **"Choose apps"** switch in its confirmation dialog is the fix, and
  PatchIt does not mention it. Planned: say so in the confirmation, default to
  sources that *match* the installed version, and let the user pick.
- No CI. Releases are manual and have already produced one signature mismatch.
- No unit tests for the verdict engine; no UI/screenshot tests. The two bugs users
  reported were both invisible to types, builds and the existing suites.
- R8 off → ~3.6 MB where ~1.5 MB is achievable.

**Do not** rewrite or repack a third-party `.mpp` to filter apps. A `.mpp` is a JAR
wrapping a compiled DEX (`loadPatchesFromDex`, `validateDexEntries`), patch classes
have a dependency graph, the result breaks on the next source update, and Morphe's
`Choose apps` filter already achieves the same outcome reversibly.
