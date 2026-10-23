package app.opendock.keepalive

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Keeps Open Dock's process, Wi-Fi and (when hands-free is on) microphone running while the app is in the background. */
class KeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "PC connection", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while Open Dock stays connected to your PC in the background"
          setShowBadge(false)
        },
      )
    }
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle(intent?.getStringExtra(TITLE) ?: "Open Dock")
      .setContentText(intent?.getStringExtra(TEXT) ?: "Connected to your PC")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setSilent(true)
      .setContentIntent(open)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
    val microphone = intent?.getBooleanExtra(MICROPHONE, false) == true &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val connected = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE else 0
    val types = if (microphone && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) connected or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else connected
    try {
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types)
    } catch (error: Exception) {
      // Android 14+ refuses a microphone service started from the background; keep the connection part.
      ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, connected)
    }
    if (wakeLock == null) {
      wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenDock::Connection")
        .apply { setReferenceCounted(false); acquire() }
    }
    if (wifiLock == null) {
      @Suppress("DEPRECATION")
      val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
        .createWifiLock(mode, "OpenDock::Connection")
        .apply { setReferenceCounted(false); acquire() }
    }
    return START_NOT_STICKY
  }

  // Swiping Open Dock away from recent apps ends the connection and the notification with it.
  override fun onTaskRemoved(rootIntent: Intent?) {
    stopSelf()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    wakeLock?.release()
    wifiLock?.release()
    wakeLock = null
    wifiLock = null
    super.onDestroy()
  }

  companion object {
    const val CHANNEL = "opendock-connection"
    const val NOTIFICATION_ID = 4021
    const val TITLE = "title"
    const val TEXT = "text"
    const val MICROPHONE = "microphone"
  }
}
