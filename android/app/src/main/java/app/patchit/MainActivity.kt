package app.patchit

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * Host activity.
 *
 * Plugins must be registered *before* `super.onCreate` — Capacitor builds its
 * plugin registry during the Bridge's own onCreate, and a plugin registered
 * afterwards is simply never wired up (and fails silently, which is a genuinely
 * annoying thing to debug).
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AppScannerPlugin::class.java)
        registerPlugin(SystemThemePlugin::class.java)
        registerPlugin(MorpheBridgePlugin::class.java)
        registerPlugin(AppUpdaterPlugin::class.java)

        super.onCreate(savedInstanceState)
    }
}
