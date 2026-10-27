package app.opendock.opencam

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class OpenCamModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenCam")
    Events("onUpdate")

    OnCreate {
      CamService.listener = { json -> sendEvent("onUpdate", mapOf("json" to json)) }
    }
    OnDestroy { CamService.listener = null }

    // token: the pairing key the PC must send before it may see the camera.
    Function("start") { token: String ->
      val context = appContext.reactContext ?: return@Function
      CamService.token = token
      try { ContextCompat.startForegroundService(context, Intent(context, CamService::class.java)) } catch (_: Exception) { }
    }

    Function("stop") { CamService.instance?.quit() }

    // The last caps/state, so a screen opened while the service runs can draw at once.
    Function("snapshot") { CamService.lastJson }

    Function("set") { key: String, value: String ->
      // value is JSON (true, 1.5, "back"): the same types the PC sends.
      val v = JSONObject("{\"v\":$value}").get("v")
      CamService.instance?.set(key, v)
    }
  }
}
