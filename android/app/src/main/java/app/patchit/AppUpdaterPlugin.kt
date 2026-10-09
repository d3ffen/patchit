package app.patchit

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Downloads a release APK and hands it to the system installer.
 *
 * This has to be native. The WebView could fetch the bytes, but getting 3.5 MB
 * out of JavaScript and onto disk means base64 through the bridge — a third
 * more data and a copy of the whole file in memory — and then a plugin to write
 * it. `HttpURLConnection` streams straight to the cache directory instead, and
 * progress comes back as events rather than through a poll.
 *
 * Installing is deliberately *not* automatic: this plugin hands the APK to the
 * package installer and Android shows its own confirmation. An app that can
 * silently replace itself is not something to build, and on Android 8+ the user
 * has to grant "install unknown apps" to PatchIt before the installer will even
 * accept the hand-off.
 */
@CapacitorPlugin(name = "AppUpdater")
class AppUpdaterPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Downloaded APKs live here, so clearing the cache clears them too. */
    private fun updatesDir(): File = File(context.cacheDir, "updates").apply { mkdirs() }

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("url is required")
            return
        }
        val fileName = sanitiseFileName(call.getString("fileName")) ?: run {
            call.reject("fileName is required")
            return
        }
        val expectedBytes = call.getInt("expectedBytes", 0)?.toLong() ?: 0L

        // Captured before the coroutine, for the same reason as the scanner.
        val packageName = context.packageName
        val directory = updatesDir()

        scope.launch {
            var connection: HttpURLConnection? = null
            try {
                val destination = File(directory, fileName)
                if (destination.exists()) destination.delete()

                connection = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20_000
                    readTimeout = 60_000
                    instanceFollowRedirects = true
                    setRequestProperty("Accept", "application/octet-stream")
                    // GitHub serves release assets from a different host after a
                    // redirect, and refuses requests without a user agent.
                    setRequestProperty("User-Agent", packageName)
                }

                val status = connection.responseCode
                if (status !in 200..299) {
                    call.reject("Download failed: HTTP $status")
                    return@launch
                }

                val total = connection.contentLengthLong.takeIf { it > 0 } ?: expectedBytes
                var copied = 0L
                var lastPercent = -1

                connection.inputStream.use { input ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read <= 0) break
                            output.write(buffer, 0, read)
                            copied += read

                            if (total > 0) {
                                val percent = ((copied * 100) / total).toInt()
                                // One event per percent: enough for a smooth bar,
                                // few enough not to swamp the bridge.
                                if (percent != lastPercent) {
                                    lastPercent = percent
                                    notifyListeners(
                                        "downloadProgress",
                                        JSObject().apply {
                                            put("percent", percent)
                                            put("bytes", copied)
                                            put("total", total)
                                        },
                                    )
                                }
                            }
                        }
                    }
                }

                if (copied == 0L) {
                    destination.delete()
                    call.reject("Download produced an empty file")
                    return@launch
                }

                call.resolve(
                    JSObject().apply {
                        put("path", destination.absolutePath)
                        put("fileName", fileName)
                        put("bytes", copied)
                    },
                )
            } catch (error: Exception) {
                call.reject("Download failed: ${error.message}", error)
            } finally {
                connection?.disconnect()
            }
        }
    }

    /**
     * Hand a downloaded APK to the package installer.
     *
     * The path is validated to be inside our own updates directory before it is
     * exposed. A FileProvider URI is a capability — anything that can reach this
     * method could otherwise ask it to share an arbitrary file out of the app's
     * private storage.
     */
    @PluginMethod
    fun install(call: PluginCall) {
        val path = call.getString("path") ?: run {
            call.reject("path is required")
            return
        }

        val file = File(path).canonicalFile
        val allowedRoot = updatesDir().canonicalFile

        if (!file.path.startsWith(allowedRoot.path + File.separator)) {
            call.reject("Refusing to install a file outside the updates directory")
            return
        }
        if (!file.exists() || file.length() == 0L) {
            call.reject("Downloaded file is missing or empty")
            return
        }

        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls()) {
            call.resolve(
                JSObject().apply {
                    put("launched", false)
                    put("reason", "permission")
                },
            )
            return
        }

        try {
            val uri: Uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                file,
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve(JSObject().apply { put("launched", true) })
        } catch (error: Exception) {
            call.reject("Could not start the installer: ${error.message}", error)
        }
    }

    /** Whether Android will let us hand an APK to the installer at all. */
    @PluginMethod
    fun canInstall(call: PluginCall) {
        val allowed = Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()
        call.resolve(JSObject().apply { put("allowed", allowed) })
    }

    /** The per-app "install unknown apps" screen, so the user can grant it. */
    @PluginMethod
    fun openInstallSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT < 26) {
            call.resolve()
            return
        }
        try {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                },
            )
            call.resolve()
        } catch (error: Exception) {
            call.reject("Could not open the install-permission screen: ${error.message}", error)
        }
    }

    /** Forget downloaded APKs; the cache is ours to tidy. */
    @PluginMethod
    fun clearDownloads(call: PluginCall) {
        scope.launch {
            updatesDir().listFiles()?.forEach { it.delete() }
            call.resolve()
        }
    }

    /**
     * A file name safe to join onto a directory path.
     *
     * The name comes from a remote release, so it is untrusted input: stripping
     * separators and leading dots keeps a crafted asset name from writing
     * anywhere but the updates directory.
     */
    private fun sanitiseFileName(raw: String?): String? {
        val name = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val cleaned = name
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .trimStart('.')
        return cleaned.takeIf { it.isNotEmpty() && it.endsWith(".apk", ignoreCase = true) }
    }

    override fun handleOnDestroy() {
        scope.coroutineContext[Job]?.cancel()
        super.handleOnDestroy()
    }
}
