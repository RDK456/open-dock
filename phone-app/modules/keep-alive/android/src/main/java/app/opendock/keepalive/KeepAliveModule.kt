package app.opendock.keepalive

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class KeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("KeepAlive")

    Function("start") { title: String, text: String, microphone: Boolean ->
      val context = appContext.reactContext ?: return@Function
      val intent = Intent(context, KeepAliveService::class.java)
        .putExtra(KeepAliveService.TITLE, title)
        .putExtra(KeepAliveService.TEXT, text)
        .putExtra(KeepAliveService.MICROPHONE, microphone)
      ContextCompat.startForegroundService(context, intent)
    }

    // Back on the deck sends the app behind others instead of closing it, so the connection keeps going.
    Function("moveToBack") {
      appContext.currentActivity?.moveTaskToBack(true)
      Unit
    }

    Function("isIgnoringBatteryOptimizations") {
      val context = appContext.reactContext
      context != null && (context.getSystemService(android.content.Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName)
    }

    // Android's own prompt to let Open Dock run without battery limits (phone makers' cleaners respect it too).
    Function("requestIgnoreBatteryOptimizations") {
      val activity = appContext.currentActivity
      activity?.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${activity.packageName}")))
      Unit
    }

    Function("stop") {
      appContext.reactContext?.let { context -> context.stopService(Intent(context, KeepAliveService::class.java)) }
      Unit
    }
  }
}
