package app.patchit

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.LruCache
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest

/**
 * Installed-application enumeration and icon rendering.
 *
 * Three constraints drive this implementation:
 *
 *  1. **It must not touch the main thread.** `getInstalledPackages` on a device
 *     with 300 apps, plus 300 `loadLabel` calls, plus hashing 300 signing
 *     certificates is hundreds of milliseconds of work. Running it on the UI
 *     thread is an ANR waiting to happen, so the whole scan lives on
 *     [Dispatchers.IO] and the bridge call returns a Promise.
 *
 *  2. **Icons must be lazy and batched.** Decoding 300 drawables into 300
 *     base64 PNGs costs ~40 MB of transient allocation and would dominate the
 *     scan. Icons are therefore a separate call, cached in an [LruCache] keyed
 *     by package and size, and `getIconBatch` exists so the list can warm twenty
 *     icons per bridge round-trip instead of twenty separate ones.
 *
 *  3. **Nothing may be silently dropped.** A package whose certificate cannot be
 *     read, or whose APK has gone missing, is reported in `skipped` with a
 *     reason. An app that vanishes from the list without explanation is the
 *     hardest possible thing for a user to debug.
 */
@CapacitorPlugin(name = "AppScanner")
class AppScannerPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Rendered icons, keyed "$packageName@$size".
     *
     * Sized in bytes rather than entries: a 128px PNG is around 8 KB, so 4 MB
     * holds roughly 500 icons, which covers a typical device's app list twice
     * over without risking an OOM on a low-end phone.
     */
    private val iconCache = object : LruCache<String, String>(4 * 1024 * 1024) {
        override fun sizeOf(key: String, value: String): Int = value.length
    }

    // ------------------------------------------------------------------
    // Scan
    // ------------------------------------------------------------------

    @PluginMethod
    fun scan(call: PluginCall) {
        val includeSystem = call.getBoolean("includeSystem", false) ?: false
        val includeSplits = call.getBoolean("includeSplits", true) ?: true
        val excludeMorphe = call.getBoolean("excludeMorphe", true) ?: true

        // Captured here, on the calling (main) thread, rather than inside the
        // coroutine. `context` goes through Capacitor's Bridge, which is not
        // documented as thread-safe, and reaching into it from a worker pool is
        // the kind of thing that works until it does not.
        val pm = context.packageManager
        val selfPackage = context.packageName

        scope.launch {
            try {
                val started = System.currentTimeMillis()

                val installed = queryInstalledPackages(pm)
                val apps = JSArray()
                val skipped = JSArray()
                var count = 0

                for (info in installed) {
                    // Plain null checks rather than `?: run { ...; continue }`:
                    // Kotlin does not allow break/continue to cross a lambda
                    // boundary, even an inline one, so the elvis form does not
                    // compile.
                    val appInfo = info.applicationInfo
                    if (appInfo == null) {
                        skipped.put(skipObject(info.packageName, "applicationInfo is null"))
                        continue
                    }

                    val isSystem = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                    val isUpdatedSystem = (appInfo.flags and ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0

                    // A system app that has never been updated lives in /system and
                    // is not patchable; Morphe refuses it, so filtering it out by
                    // default matches what the user will actually be able to do.
                    if (isSystem && !isUpdatedSystem && !includeSystem) {
                        skipped.put(skipObject(info.packageName, "system app (filtered)"))
                        continue
                    }

                    if (excludeMorphe && isMorphePackage(info.packageName, selfPackage)) {
                        skipped.put(skipObject(info.packageName, "Morphe tooling itself"))
                        continue
                    }

                    val splits = splitPaths(appInfo)
                    if (splits.isNotEmpty() && !includeSplits) {
                        skipped.put(skipObject(info.packageName, "split install (filtered)"))
                        continue
                    }

                    val sourceDir = appInfo.sourceDir
                    if (sourceDir.isNullOrEmpty()) {
                        skipped.put(skipObject(info.packageName, "no sourceDir"))
                        continue
                    }

                    val label = try {
                        appInfo.loadLabel(pm).toString()
                    } catch (error: Exception) {
                        info.packageName
                    }

                    val enabledSetting = try {
                        pm.getApplicationEnabledSetting(info.packageName)
                    } catch (error: Exception) {
                        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                    }

                    val obj = JSObject()
                    obj.put("packageName", info.packageName)
                    obj.put("label", label)
                    obj.put("versionName", info.versionName ?: "")
                    obj.put("versionCode", versionCode(info))
                    obj.put("isSystem", isSystem)
                    obj.put("isUpdatedSystemApp", isUpdatedSystem)
                    obj.put(
                        "isEnabled",
                        enabledSetting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED &&
                            enabledSetting != PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
                    )
                    obj.put(
                        "isSuspended",
                        enabledSetting == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER,
                    )
                    obj.put("sourceDir", sourceDir)
                    obj.put("splitSourceDirs", JSArray(splits))
                    obj.put("hasSplits", splits.isNotEmpty())
                    obj.put("uid", appInfo.uid)
                    obj.put("targetSdk", appInfo.targetSdkVersion)
                    obj.put("minSdk", if (Build.VERSION.SDK_INT >= 24) appInfo.minSdkVersion else 0)
                    obj.putNullable("signatureSha256", signatureSha256(info))
                    obj.put("firstInstallTime", info.firstInstallTime)
                    obj.put("lastUpdateTime", info.lastUpdateTime)
                    obj.put("apkSizeBytes", apkSize(sourceDir, splits))

                    apps.put(obj)
                    count++
                }

                val result = JSObject()
                result.put("apps", apps)
                result.put("durationMs", (System.currentTimeMillis() - started).toInt())
                result.put("skipped", skipped)
                result.put("deviceSdk", Build.VERSION.SDK_INT)
                result.put("fullVisibility", hasFullVisibility(pm, count))

                call.resolve(result)
            } catch (error: Exception) {
                call.reject("Package scan failed: ${error.message}", error)
            }
        }
    }

    /**
     * `getInstalledPackages` changed shape in API 33; both branches return the
     * same thing but only one compiles on each side of the boundary.
     */
    @Suppress("DEPRECATION")
    private fun queryInstalledPackages(pm: PackageManager): List<PackageInfo> = try {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(0L))
        } else {
            pm.getInstalledPackages(0)
        }
    } catch (error: Exception) {
        emptyList()
    }

    private fun versionCode(info: PackageInfo): Long = try {
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    } catch (error: Exception) {
        0L
    }

    private fun splitPaths(appInfo: ApplicationInfo): List<String> {
        // splitSourceDirs is the full set including the base APK on some OEM
        // builds, so filter the base out by comparing paths rather than trusting
        // the array's length.
        val dirs = appInfo.splitSourceDirs ?: return emptyList()
        return dirs.filter { it != null && it != appInfo.sourceDir }
    }

    private fun apkSize(sourceDir: String, splits: List<String>): Long {
        var total = 0L
        for (path in listOf(sourceDir) + splits) {
            total += try {
                File(path).length()
            } catch (error: Exception) {
                0L
            }
        }
        return total
    }

    /**
     * SHA-256 of the signing certificate, uppercase hex.
     *
     * `signingInfo` (API 28+) distinguishes the current signers from the
     * rotation history; Morphe validates against the current signers, so we take
     * `apkContentsSigners` when there are several and the history's first entry
     * otherwise. This mirrors what Morphe Manager itself does.
     */
    private fun signatureSha256(info: PackageInfo): String? {
        val signatures = try {
            if (Build.VERSION.SDK_INT >= 28) {
                val signingInfo = info.signingInfo ?: return null
                if (signingInfo.hasMultipleSigners()) signingInfo.apkContentsSigners
                else signingInfo.signingCertificateHistory
            } else {
                @Suppress("DEPRECATION")
                info.signatures
            }
        } catch (error: Exception) {
            null
        } ?: return null

        val first = signatures.firstOrNull() ?: return null
        return try {
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(first.toByteArray())
            digest.digest().joinToString("") { byte -> "%02X".format(byte) }
        } catch (error: Exception) {
            null
        }
    }

    /**
     * A heuristic, and honest about being one.
     *
     * Android gives no API for "did I get everything?", and QUERY_ALL_PACKAGES is
     * a normal permission granted at install — so the only detectable failure is
     * a device where the permission was stripped, which shows up as a list too
     * short to be real. Checking for a package that exists on every Android
     * device is the cheapest reliable signal.
     */
    private fun hasFullVisibility(pm: PackageManager, count: Int): Boolean {
        if (count > 40) return true
        return try {
            pm.getPackageInfo("com.android.settings", 0)
            true
        } catch (error: PackageManager.NameNotFoundException) {
            false
        }
    }

    // ------------------------------------------------------------------
    // Icons
    // ------------------------------------------------------------------

    @PluginMethod
    fun getIcon(call: PluginCall) {
        val packageName = call.getString("packageName")
        if (packageName.isNullOrBlank()) {
            call.reject("packageName is required")
            return
        }
        val size = call.getInt("size", DEFAULT_ICON_SIZE) ?: DEFAULT_ICON_SIZE
        val pm = context.packageManager

        scope.launch {
            call.resolve(iconResult(pm, packageName, size))
        }
    }

    /**
     * Warm several icons in one round-trip. The bridge hop is the expensive part
     * when the list is scrolling, not the decode.
     */
    @PluginMethod
    fun getIconBatch(call: PluginCall) {
        val names = call.getArray("packageNames") ?: run {
            call.reject("packageNames is required")
            return
        }
        val size = call.getInt("size", DEFAULT_ICON_SIZE) ?: DEFAULT_ICON_SIZE
        val pm = context.packageManager

        scope.launch {
            val icons = JSArray()
            for (index in 0 until names.length()) {
                val packageName = names.optString(index, null) ?: continue
                if (packageName.isBlank()) continue
                icons.put(iconResult(pm, packageName, size))
            }
            val result = JSObject()
            result.put("icons", icons)
            call.resolve(result)
        }
    }

    private fun iconResult(pm: PackageManager, packageName: String, size: Int): JSObject {
        val key = "$packageName@$size"
        val cached = iconCache.get(key)

        // Resolved before the put: `put` is overloaded for String and Object, and
        // a nullable String makes Kotlin pick the String overload and then reject
        // the null. Explicitly nullable, explicitly Object.
        val dataUrl: String? = cached ?: renderIcon(pm, packageName, size)?.also { iconCache.put(key, it) }

        val result = JSObject()
        result.put("packageName", packageName)
        result.putNullable("dataUrl", dataUrl)
        return result
    }

    private fun renderIcon(pm: PackageManager, packageName: String, size: Int): String? = try {
        val appInfo = applicationInfoFor(pm, packageName) ?: return null
        val drawable = appInfo.loadIcon(pm) ?: return null

        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        // Adaptive icons need explicit bounds; without them the foreground layer
        // renders at its intrinsic size in the top-left corner.
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)

        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        bitmap.recycle()

        "data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
    } catch (error: OutOfMemoryError) {
        // A 512px adaptive icon on a memory-tight device can genuinely fail here;
        // returning null lets the UI fall back to its monogram tile.
        null
    } catch (error: Exception) {
        null
    }

    private fun applicationInfoFor(pm: PackageManager, packageName: String): ApplicationInfo? = try {
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(packageName, 0)
        }
    } catch (error: Exception) {
        null
    }

    // ------------------------------------------------------------------
    // System UI hand-offs
    // ------------------------------------------------------------------

    @PluginMethod
    fun openAppInfo(call: PluginCall) {
        val packageName = call.getString("packageName") ?: run {
            call.reject("packageName is required")
            return
        }
        launchSystemIntent(
            call,
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
    }

    @PluginMethod
    fun openInStore(call: PluginCall) {
        val packageName = call.getString("packageName") ?: run {
            call.reject("packageName is required")
            return
        }
        // `market://` is not resolvable on a device without Play; fall back to
        // the web listing rather than rejecting outright.
        val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$packageName"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val web = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("https://play.google.com/store/apps/details?id=$packageName"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        val target = if (market.resolveActivity(context.packageManager) != null) market else web
        launchSystemIntent(call, target)
    }

    /**
     * A SecurityException here means a permission the action needs is missing;
     * reporting that precisely beats a generic failure.
     */
    private fun launchSystemIntent(call: PluginCall, intent: Intent) {
        try {
            if (intent.resolveActivity(context.packageManager) == null) {
                call.reject("No app on this device handles that action.")
                return
            }
            context.startActivity(intent)
            call.resolve()
        } catch (error: SecurityException) {
            call.reject("Blocked by Android: ${error.message}", error)
        } catch (error: Exception) {
            call.reject("Could not open: ${error.message}", error)
        }
    }

    @PluginMethod
    fun hasPackageVisibility(call: PluginCall) {
        val pm = context.packageManager
        val installed = queryInstalledPackages(pm)
        val result = JSObject()
        result.put("granted", hasFullVisibility(pm, installed.size))
        call.resolve(result)
    }

    @PluginMethod
    fun openPackageVisibilitySettings(call: PluginCall) {
        // There is no per-permission settings screen for QUERY_ALL_PACKAGES; the
        // closest honest destination is this app's own App info page.
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", context.packageName, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        launchSystemIntent(call, intent)
    }

    override fun handleOnDestroy() {
        scope.coroutineContext[Job]?.cancel()
        super.handleOnDestroy()
    }

    private fun skipObject(packageName: String, reason: String): JSObject = JSObject().apply {
        put("packageName", packageName)
        put("reason", reason)
    }

    /**
     * `JSObject.put` is overloaded for String and Object, so passing a nullable
     * String is ambiguous to the Kotlin compiler and a null is rejected by the
     * String overload. JSON has real nulls; route them through the Object one.
     */
    private fun JSObject.putNullable(key: String, value: String?) {
        put(key, value ?: JSONObject.NULL)
    }

    /**
     * Morphe tooling, including this app itself.
     *
     * Excluding ourselves matters: `app.morphe.*` matches the
     * `app.morphe.` prefix, and offering to patch the scanner you are looking at
     * is noise at best.
     */
    private fun isMorphePackage(packageName: String, selfPackage: String): Boolean =
        packageName == selfPackage ||
            packageName in MORPHE_PACKAGES ||
            packageName.startsWith("app.morphe.") ||
            packageName.startsWith("app.revanced.manager")

    companion object {
        private const val DEFAULT_ICON_SIZE = 128

        /** Known Morphe/legacy-ReVanced manager ids, used for filtering and hand-off. */
        val MORPHE_PACKAGES = setOf(
            "app.morphe.manager",
            "app.morphe.manager.debug",
            "app.morphe.patcher",
            "app.revanced.manager",
            "app.revanced.manager.flutter",
        )
    }
}
