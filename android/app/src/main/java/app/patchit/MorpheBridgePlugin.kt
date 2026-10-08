package app.patchit

import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

/**
 * Hands patch *sources* to Morphe Manager. It does not ask Morphe to patch
 * anything, and that is a deliberate boundary rather than a missing feature.
 *
 * Morphe Manager exposes two things to other apps. This scanner uses exactly one
 * of them:
 *
 *   **Adding a patch source** — an ordinary https deep link:
 *       https://morphe.software/add-source?github=owner/repo[&name=Display%20Name]
 *   Morphe validates the repository and asks the user to confirm before anything
 *   is added. Only GitHub and GitLab are accepted this way.
 *
 * The other is batch patching:
 *
 *       action  app.morphe.manager.action.BATCH_PATCH
 *       extra   packages = String[] | comma-separated String
 *
 * It is intentionally not implemented. `BATCH_PATCH` queues apps for Morphe to
 * patch and install, and a scanner that quietly arms a patch-and-install queue
 * from a single tap is the wrong shape for this tool: what a user actually needs
 * from a scanner is for the sources covering their apps to be present in Morphe,
 * after which Morphe's own UI does the patching with full context about what it
 * is about to do.
 *
 * The practical consequence is that this plugin never calls
 * `startActivityForResult`, never needs an `@ActivityCallback`, and therefore
 * does not need androidx.activity on the compile classpath — which it otherwise
 * would, because `capacitor-android` depends on androidx.activity with
 * `implementation`, not `api`, and does not expose it to consumers.
 */
@CapacitorPlugin(name = "MorpheBridge")
class MorpheBridgePlugin : Plugin() {

    /**
     * Cached candidate list.
     *
     * Building it walks every installed package, which on a 300-app device is a
     * full PackageManager enumeration. The set of installed Morphe builds does
     * not change while the app is in the foreground, so paying that cost per
     * call would be careless.
     */
    private var cachedCandidates: List<String>? = null

    // ------------------------------------------------------------------
    // Discovery
    // ------------------------------------------------------------------

    /**
     * Discover Morphe installs rather than hard-coding one id.
     *
     * The application id has already changed once (`app.revanced.manager` ->
     * `app.morphe.manager`), forks exist, and debug builds carry a `.debug`
     * suffix. Scanning means the app survives a rename, and QUERY_ALL_PACKAGES is
     * requested for the scanner anyway.
     */
    @PluginMethod
    fun findMorpheInstalls(call: PluginCall) {
        val pm = context.packageManager
        val installs = JSArray()

        for (packageName in morphePackages(pm, refresh = true)) {
            val launch = safeLaunchIntent(pm, packageName)
            val versionName = try {
                pm.getPackageInfo(packageName, 0).versionName ?: ""
            } catch (error: Exception) {
                ""
            }

            val installer = JSObject()
            installer.put("packageName", packageName)
            installer.put("label", labelFor(pm, packageName))
            installer.put("versionName", versionName)
            installer.putNullable("launcherActivity", launch?.component?.className)
            installer.put("handlesSourceLinks", resolvesSourceLink(pm, packageName))
            installs.put(installer)
        }

        val result = JSObject()
        result.put("installs", installs)
        call.resolve(result)
    }

    // ------------------------------------------------------------------
    // Add a patch source
    // ------------------------------------------------------------------

    /**
     * Open an `add-source` link in Morphe.
     *
     * Scoped to the Morphe package first so a browser cannot steal the link —
     * without `setPackage`, a user with a default browser that handles
     * `morphe.software` never reaches Morphe at all.
     */
    @PluginMethod
    fun openSourceLink(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("url is required")
            return
        }

        val uri = Uri.parse(url)
        if (uri.scheme != "https" && uri.scheme != "http") {
            call.reject("Only http(s) add-source links are supported.")
            return
        }

        val pm = context.packageManager
        val view = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        val handler = firstSourceLinkHandler(pm)
        if (handler != null) {
            val scoped = Intent(view).setPackage(handler)
            if (scoped.resolveActivity(pm) != null) {
                try {
                    context.startActivity(scoped)
                    call.resolve(delivered("$handler/${uri.host}"))
                    return
                } catch (error: SecurityException) {
                    call.resolve(notDelivered("security-exception", error.message))
                    return
                } catch (error: Exception) {
                    // Fall through to the unscoped intent.
                }
            }
        }

        if (view.resolveActivity(pm) == null) {
            call.resolve(notDelivered("no-activity", "Nothing on this device handles $url"))
            return
        }

        try {
            context.startActivity(view)
            // Opening a browser is not success. Saying so is the difference
            // between the user knowing Morphe is missing and wondering why the
            // source never appeared.
            call.resolve(
                notDelivered("not-installed", "Opened in a browser; Morphe is not installed."),
            )
        } catch (error: Exception) {
            call.resolve(notDelivered("unknown", error.message))
        }
    }

    // ------------------------------------------------------------------
    // Morphe's own settings
    // ------------------------------------------------------------------

    /**
     * Open Morphe so the user can act there.
     *
     * There is no public way to deep-link into another app's preference screen,
     * so the honest destination is Morphe's launcher, with the instructions shown
     * in our own UI next to it. If that fails, the App info page.
     */
    @PluginMethod
    fun openMorpheSettings(call: PluginCall) {
        val requested = call.getString("packageName")
        val pm = context.packageManager
        val packageName = requested ?: morphePackages(pm, refresh = false).firstOrNull()

        if (packageName == null) {
            call.resolve(notDelivered("not-installed", "Morphe Manager is not installed."))
            return
        }

        val launch = safeLaunchIntent(pm, packageName)

        val intent = launch?.apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
            ?: Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.fromParts("package", packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

        try {
            context.startActivity(intent)
            call.resolve(
                delivered(intent.component?.let { "${it.packageName}/${it.className}" } ?: packageName),
            )
        } catch (error: Exception) {
            call.resolve(notDelivered("unknown", error.message))
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun delivered(resolvedActivity: String): JSObject = JSObject().apply {
        put("delivered", true)
        put("resolvedActivity", resolvedActivity)
    }

    private fun notDelivered(reason: String, message: String?): JSObject = JSObject().apply {
        put("delivered", false)
        putNullable("resolvedActivity", null)
        put("reason", reason)
        putNullable("message", message)
    }

    /**
     * Installed Morphe-like packages, best-known first.
     *
     * Three signals, because no single one is sufficient: the ids we know about,
     * anything else that calls itself Morphe or the legacy ReVanced manager, and
     * — the signal that actually matters for this app — anything that resolves an
     * add-source link.
     */
    private fun morphePackages(pm: PackageManager, refresh: Boolean): List<String> {
        if (!refresh) cachedCandidates?.let { return it }

        val found = HashSet<String>()

        for (known in AppScannerPlugin.MORPHE_PACKAGES) {
            try {
                pm.getPackageInfo(known, 0)
                found.add(known)
            } catch (error: PackageManager.NameNotFoundException) {
                // Not installed; expected for most of the list.
            }
        }

        for (packageName in installedPackageNames(pm)) {
            if (packageName.startsWith("app.morphe.") ||
                packageName.startsWith("app.revanced.manager")
            ) {
                found.add(packageName)
            }
        }

        found.addAll(packagesResolving(pm, sourceLinkProbe()))

        val sorted = found.sortedWith(
            compareBy(
                { it != "app.morphe.manager" },
                { it.contains("debug") },
                { it },
            ),
        )
        cachedCandidates = sorted
        return sorted
    }

    /** The first installed Morphe that would actually accept an add-source link. */
    private fun firstSourceLinkHandler(pm: PackageManager): String? =
        morphePackages(pm, refresh = false).firstOrNull { resolvesSourceLink(pm, it) }

    private fun resolvesSourceLink(pm: PackageManager, packageName: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, sourceLinkProbe()).setPackage(packageName)
        return try {
            intent.resolveActivity(pm) != null
        } catch (error: Exception) {
            false
        }
    }

    /**
     * A throwaway link used only to ask "who handles add-source?".
     *
     * Morphe's filter is `scheme=https host=morphe.software pathPrefix=/add-source`,
     * so the probe has to carry all three parts or it matches browsers instead.
     */
    private fun sourceLinkProbe(): Uri =
        Uri.parse("https://morphe.software/add-source?github=probe/probe")

    private fun packagesResolving(pm: PackageManager, uri: Uri): Set<String> {
        val resolved: List<ResolveInfo> = try {
            if (Build.VERSION.SDK_INT >= 33) {
                pm.queryIntentActivities(
                    Intent(Intent.ACTION_VIEW, uri),
                    PackageManager.ResolveInfoFlags.of(0L),
                )
            } else {
                @Suppress("DEPRECATION")
                pm.queryIntentActivities(Intent(Intent.ACTION_VIEW, uri), 0)
            }
        } catch (error: Exception) {
            emptyList()
        }
        return resolved.mapNotNull { it.activityInfo?.packageName }.toSet()
    }

    @Suppress("DEPRECATION")
    private fun installedPackageNames(pm: PackageManager): List<String> = try {
        val packages = if (Build.VERSION.SDK_INT >= 33) {
            pm.getInstalledPackages(PackageManager.PackageInfoFlags.of(0L))
        } else {
            pm.getInstalledPackages(0)
        }
        packages.map { it.packageName }
    } catch (error: Exception) {
        emptyList()
    }

    private fun safeLaunchIntent(pm: PackageManager, packageName: String): Intent? = try {
        pm.getLaunchIntentForPackage(packageName)
    } catch (error: Exception) {
        null
    }

    private fun labelFor(pm: PackageManager, packageName: String): String = try {
        val info = if (Build.VERSION.SDK_INT >= 33) {
            pm.getApplicationInfo(packageName, PackageManager.ApplicationInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            pm.getApplicationInfo(packageName, 0)
        }
        info.loadLabel(pm).toString()
    } catch (error: Exception) {
        packageName
    }

    /** See the note in AppScannerPlugin: nullable Strings need the Object overload. */
    private fun JSObject.putNullable(key: String, value: String?) {
        put(key, value ?: JSONObject.NULL)
    }
}
