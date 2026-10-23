package app.opendock.keepalive

import android.content.Intent
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

    Function("stop") {
      appContext.reactContext?.let { context -> context.stopService(Intent(context, KeepAliveService::class.java)) }
      Unit
    }
  }
}
