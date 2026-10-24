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

    Function("canDrawOverlays") {
      appContext.reactContext?.let { Settings.canDrawOverlays(it) } ?: false
    }

    // Android's screen for "Display over other apps", which the voice island needs.
    Function("requestOverlayPermission") {
      val activity = appContext.currentActivity
      activity?.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}")))
      Unit
    }

    Function("showIsland") { state: String, text: String ->
      appContext.reactContext?.let { IslandOverlay.show(it, state, text) }
      Unit
    }

    Function("hideIsland") {
      appContext.reactContext?.let { IslandOverlay.hide(it) }
      Unit
    }

    Function("stop") {
      appContext.reactContext?.let { context -> context.stopService(Intent(context, KeepAliveService::class.java)) }
      Unit
    }

    // Delta updates (see DeltaPatch): the installed APK's SHA-256, and the new APK rebuilt from it and a patch.
    AsyncFunction("installedApkSha256") {
      val context = appContext.reactContext ?: throw IllegalStateException("no app context")
      DeltaPatch.sha256(java.io.File(context.applicationInfo.sourceDir))
    }

    AsyncFunction("applyApkPatch") { patchPath: String, outPath: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("no app context")
      DeltaPatch.apply(java.io.File(context.applicationInfo.sourceDir), java.io.File(patchPath.removePrefix("file://")), java.io.File(outPath.removePrefix("file://")))
    }
  }
}
