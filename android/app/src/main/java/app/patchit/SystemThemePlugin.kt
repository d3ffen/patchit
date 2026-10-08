package app.patchit

import android.content.res.Configuration
import android.os.Build
import com.getcapacitor.JSObject
import org.json.JSONObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Material You colour source.
 *
 * On Android 12+ the platform exposes the wallpaper-derived tonal palettes as
 * resources (`android.R.color.system_accent1_*` and friends). Those are the
 * actual Monet output, and reading them is the only way to be genuinely
 * "dynamic" rather than "approximately dynamic".
 *
 * What this plugin does *not* do is compute the full 48-role scheme. That stays
 * in TypeScript, for three reasons:
 *
 *  - the Material Color Utilities library already implements the identical
 *    algorithm (`SchemeTonalSpot` is what Android itself uses), so seeding it
 *    with `system_accent1_500` reproduces the platform's palette closely;
 *  - the role set has to exist on devices with no Monet at all, so a JS
 *    implementation is needed regardless;
 *  - having one implementation instead of two means the light/dark roles cannot
 *    drift between the native and web builds.
 *
 * The raw tonal stops are returned anyway, so Settings can show what the device
 * actually handed over instead of a derived approximation of it.
 */
@CapacitorPlugin(name = "SystemTheme")
class SystemThemePlugin : Plugin() {

    /** Palette tones the platform publishes. Not every device defines all of them. */
    private val accentStops = listOf(0, 10, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000)

    @PluginMethod
    fun getPalette(call: PluginCall) {
        val result = JSObject()

        val accent = readTonalPalette("system_accent1_")
        val neutral = readTonalPalette("system_neutral1_")

        // Android 12 is API 31, and that is exactly when the system_* colours
        // were introduced. Below it there is nothing to read and we say so
        // rather than inventing a colour.
        val dynamicAvailable = Build.VERSION.SDK_INT >= 31 &&
            accent[500] != null &&
            neutral[500] != null

        result.put("dynamicAvailable", dynamicAvailable)
        result.putNullable("accentArgb", accent[500])
        result.putNullable("neutralArgb", neutral[500])
        result.put("systemDark", isSystemDark())
        result.put("androidSdk", Build.VERSION.SDK_INT)
        result.put("accentPalette", tonalToJs(accent))
        result.put("neutralPalette", tonalToJs(neutral))

        call.resolve(result)
    }

    @PluginMethod
    fun getThemeMode(call: PluginCall) {
        val result = JSObject()
        result.put("dark", isSystemDark())
        call.resolve(result)
    }

    /**
     * Push the OS theme change to JS.
     *
     * The WebView's own `prefers-color-scheme` can lag a manual system toggle,
     * and on some OEM builds it never updates at all until the Activity is
     * recreated. This hook fires on the real configuration change, so the app
     * repaints at the same moment the rest of the system does.
     */
    override fun handleOnConfigurationChanged(newConfig: Configuration) {
        super.handleOnConfigurationChanged(newConfig)
        val data = JSObject()
        data.put("dark", isSystemDark(newConfig))
        notifyListeners("themeChanged", data)
    }

    private fun isSystemDark(config: Configuration? = null): Boolean {
        val effective = config ?: context.resources.configuration
        val nightMode = effective.uiMode and Configuration.UI_MODE_NIGHT_MASK
        return nightMode == Configuration.UI_MODE_NIGHT_YES
    }

    /**
     * Read one tonal palette, skipping tones the device does not define.
     *
     * `getColor` throws `Resources.NotFoundException` for an undefined id, which
     * is normal on OEM builds that ship a partial palette.
     */
    private fun readTonalPalette(prefix: String): Map<Int, Int> {
        if (Build.VERSION.SDK_INT < 31) return emptyMap()

        val out = mutableMapOf<Int, Int>()
        for (tone in accentStops) {
            val id = context.resources.getIdentifier("$prefix$tone", "color", "android")
            if (id == 0) continue
            val value = try {
                context.getColor(id)
            } catch (error: Exception) {
                continue
            }
            out[tone] = value
        }
        return out
    }

    private fun tonalToJs(palette: Map<Int, Int>): JSObject = JSObject().apply {
        for ((tone, argb) in palette) put(tone.toString(), argb)
    }

    private fun JSObject.putNullable(key: String, value: Int?) {
        put(key, value ?: JSONObject.NULL)
    }
}
