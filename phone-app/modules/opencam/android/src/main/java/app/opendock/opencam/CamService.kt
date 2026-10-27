package app.opendock.opencam

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraExtensionCharacteristics
import android.hardware.camera2.CameraExtensionSession
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.ExtensionSessionConfiguration
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.net.ConnectivityManager
import android.net.LinkAddress
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.Range
import android.util.Size
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Owns the camera, the H.264 encoder and the PC link (see PROTOCOL.md).
 * Runs as a camera foreground service so streaming survives the user switching apps.
 * Camera and state work is confined to the single [cam] thread.
 */
class CamService : Service() {

    companion object {
        const val TCP_PORT = 47100
                const val T_CONFIG = 1
        const val T_FRAME = 2
        const val T_JSON = 3
        const val ACTION_QUIT = "app.opendock.opencam.QUIT"
        private const val TAG = "Open Dock Camera"
        private const val CHANNEL = "opendock_camera"
        @Volatile var instance: CamService? = null
        /** Receives {"caps":…,"state":…} as JSON on the main thread. */
        @Volatile var token = ""
        @Volatile var listener: ((String) -> Unit)? = null
        @Volatile var lastJson: String? = null

        val WB = linkedMapOf(
            "auto" to CameraMetadata.CONTROL_AWB_MODE_AUTO,
            "daylight" to CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT,
            "cloudy" to CameraMetadata.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT,
            "incandescent" to CameraMetadata.CONTROL_AWB_MODE_INCANDESCENT,
            "fluorescent" to CameraMetadata.CONTROL_AWB_MODE_FLUORESCENT,
        )
    }

    /** UI hooks, always invoked on the main thread. */
    private val main = Handler(Looper.getMainLooper())
    private val camThread = HandlerThread("cam").apply { start() }
    private val cam = Handler(camThread.looper)
    private val camExec = Executor { cam.post(it) }
    private val encThread = HandlerThread("enc").apply { start() }

    private lateinit var cameraManager: CameraManager
    private lateinit var connectivity: ConnectivityManager
    private lateinit var prefs: SharedPreferences
    private var wifiLock: WifiManager.WifiLock? = null
    @Volatile private var running = true
    private var server: ServerSocket? = null

    // cam-thread state
    private var state = JSONObject()
    private var caps = JSONObject()
    private var camId: String? = null
    private var chars: CameraCharacteristics? = null
    private var device: CameraDevice? = null
    private var opening = false
    private var openGen = 0
    private var session: CameraCaptureSession? = null
    private var extSession: CameraExtensionSession? = null
    private var sessGen = 0
    private var encoder: MediaCodec? = null
    private var encSurface: Surface? = null
    private var preview: Surface? = null
    private var demand = false
    private var notifText = ""

    // shared with encoder / network threads
    @Volatile private var conn: Conn? = null
    @Volatile private var csd: ByteArray? = null
    @Volatile private var live = true
    @Volatile private var wifiNet: Network? = null
    @Volatile private var lastFocus = 0f
    @Volatile private var lastIso = 0
    @Volatile private var lastExp = 0L

    override fun onCreate() {
        super.onCreate()
        instance = this
        cameraManager = getSystemService(CameraManager::class.java)
        connectivity = getSystemService(ConnectivityManager::class.java)
        prefs = getSharedPreferences("opencam", MODE_PRIVATE)
        state = try { JSONObject(prefs.getString("state", "{}")!!) } catch (e: Exception) { JSONObject() }
        state.put("live", true)

        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "Open Dock Camera", NotificationManager.IMPORTANCE_LOW))
        notifText = "Waiting for PC"

        wifiLock = getSystemService(WifiManager::class.java)
            .createWifiLock(WifiManager.WIFI_MODE_FULL_LOW_LATENCY, "opencam").apply { acquire() }

        cameraManager.registerAvailabilityCallback(availability, cam)
        connectivity.registerNetworkCallback(
            NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(), netCallback, cam
        )
        cam.post { selectCamera(); publish() }
        thread(name = "tcp", isDaemon = true) { serve() }
        thread(name = "ping", isDaemon = true) {
            while (running) { conn?.sendJson(JSONObject().put("t", "ping")); Thread.sleep(1000) }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every startForegroundService() must be answered with startForeground().
        startForeground(1, notification(notifText), ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        if (intent?.action == ACTION_QUIT) quit()
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    fun quit() {
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        running = false
        instance = null
        try { server?.close() } catch (_: IOException) {}
        conn?.close()
        try { connectivity.unregisterNetworkCallback(netCallback) } catch (_: Exception) {}
        cameraManager.unregisterAvailabilityCallback(availability)
        val done = CountDownLatch(1)
        cam.post { closeCamera(); done.countDown() }
        done.await(2, TimeUnit.SECONDS)
        camThread.quitSafely()
        encThread.quitSafely()
        wifiLock?.release()
        lastJson = null
        main.post { listener?.invoke("""{"quit":true}""") }
        super.onDestroy()
    }

    // ---------------------------------------------------------------- public API (any thread)

    fun set(k: String, v: Any) { cam.post { applySetting(k, v) } }

    /** Blocks briefly so the camera stops drawing into a surface that is being destroyed. */
    fun setPreview(s: Surface?) {
        val done = CountDownLatch(1)
        cam.post { preview = s; reconcile(rebuild = true); done.countDown() }
        done.await(1, TimeUnit.SECONDS)
    }

    // ---------------------------------------------------------------- state

    private fun applySetting(k: String, v: Any) {
        val oldMode = state.optString("mode", "video")
        state.put(k, v)
        if (k == "af" && v == false) state.put("focus", lastFocus.toDouble())
        if (k == "mode" && v == "pro" && lastIso > 0) state.put("iso", lastIso).put("exp", lastExp)
        clampState()
        prefs.edit().putString("state", state.toString()).apply()
        when (k) {
            "facing" -> { closeCamera(); selectCamera(); reconcile() }
            "res", "fps", "mbps" -> reconcile(rebuild = true)
            "mode" -> if (oldMode == "portrait" || state.optString("mode") == "portrait") reconcile(rebuild = true) else applyControls()
            "live" -> { live = state.optBoolean("live", true); requestKey() }
            "mirror", "rot180" -> {}
            else -> applyControls()
        }
        publish()
    }

    private fun handle(j: JSONObject) {
        when (j.optString("t")) {
            "set" -> applySetting(j.getString("k"), j.get("v"))
            "demand" -> { demand = j.optBoolean("v"); reconcile(); requestKey(); publish() }
            "key" -> requestKey()
        }
    }

    private fun publish() {
        val c = conn
        val text = when { c == null -> "Waiting for PC"; c.usb -> "Streaming over USB"; else -> "Streaming over Wi-Fi" }
        if (text != notifText) {
            notifText = text
            getSystemService(NotificationManager::class.java).notify(1, notification(text))
        }
        val st = JSONObject(state.toString()).put("t", "state")
            .put("conn", c?.let { if (it.usb) "usb" else "wifi" } ?: "")
            .put("demand", demand).put("cam", device != null).put("model", Build.MODEL)
        val cp = JSONObject(caps.toString()).put("t", "caps")
        c?.sendJson(cp)
        c?.sendJson(st)
        // UI-only extras: this phone's address and pairing code (its low 16 bits), PCs found, update state
        val la = wifiNet?.let { linkAddr(it) }
        if (la != null) st.put("ip", la.address.hostAddress).put("code", "%05d".format(ipInt(la) and 0xFFFF))
        val json = JSONObject().put("caps", cp).put("state", st).toString()
        lastJson = json
        main.post { listener?.invoke(json) }
    }

    private fun clampState() {
        val s = state
        val c = caps
        fun def(k: String, v: Any) { if (!s.has(k)) s.put(k, v) }
        def("facing", "back"); def("zoom", 1.0); def("mode", "video"); def("af", true); def("focus", 0.0)
        def("ev", 0); def("wb", "auto"); def("torch", false); def("stab", false); def("res", "1920x1080")
        def("fps", 30); def("mbps", 0); def("live", true); def("mirror", false); def("rot180", false)
        if (c.length() == 0) return
        s.put("zoom", s.optDouble("zoom", 1.0).coerceIn(c.optDouble("zoomMin", 1.0), c.optDouble("zoomMax", 1.0)))
        s.put("ev", s.optInt("ev").coerceIn(c.optInt("evMin"), c.optInt("evMax")))
        if (c.has("isoMin")) s.put("iso", s.optInt("iso", 400).coerceIn(c.getInt("isoMin"), c.getInt("isoMax")))
        if (c.has("expMin")) s.put("exp", s.optLong("exp", 16_000_000L).coerceIn(c.getLong("expMin"), c.getLong("expMax")))
        s.put("focus", s.optDouble("focus").coerceIn(0.0, c.optDouble("focusMax")))
        val modes = c.optJSONArray("modes")?.let { a -> List(a.length()) { a.getString(it) } }.orEmpty()
        if (modes.isNotEmpty()) {
            val resList = modes.map { it.substringBefore('@') }.distinct()
            if (s.optString("res") !in resList) s.put("res", if ("1920x1080" in resList) "1920x1080" else resList.first())
            val res = s.getString("res")
            if ("$res@${s.optInt("fps")}" !in modes) s.put("fps", modes.first { it.startsWith("$res@") }.substringAfter('@').toInt())
        }
        if (s.optString("mode") == "portrait" && !c.optBoolean("portrait")) s.put("mode", "video")
        if (s.optString("wb") !in WB) s.put("wb", "auto")
        val aps = c.optJSONArray("apertures")
        if (aps != null && aps.length() > 0 && !s.has("aperture")) s.put("aperture", aps.getDouble(0))
    }

    // ---------------------------------------------------------------- camera

    private fun selectCamera() {
        val want = if (state.optString("facing") == "front") CameraCharacteristics.LENS_FACING_FRONT
        else CameraCharacteristics.LENS_FACING_BACK
        val ids = cameraManager.cameraIdList
        val id = ids.firstOrNull { cameraManager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == want }
            ?: ids.firstOrNull() ?: return
        camId = id
        val c = cameraManager.getCameraCharacteristics(id)
        chars = c
        caps = computeCaps(id, c)
        clampState()
    }

    private fun computeCaps(id: String, c: CameraCharacteristics): JSONObject {
        val j = JSONObject()
        val zr = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
            ?: Range(1f, c.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) ?: 1f)
        j.put("zoomMin", zr.lower.toDouble()).put("zoomMax", zr.upper.toDouble())
        val ev = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE) ?: Range(0, 0)
        j.put("evMin", ev.lower).put("evMax", ev.upper)
            .put("evStep", c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP)?.toDouble() ?: 1.0)
        val capList = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
        j.put("manual", CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR in capList)
        c.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)?.let { j.put("isoMin", it.lower).put("isoMax", it.upper) }
        c.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)?.let { j.put("expMin", it.lower).put("expMax", it.upper) }
        j.put("focusMax", (c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f).toDouble())
        val afModes = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES) ?: IntArray(0)
        j.put("af", CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO in afModes)
        j.put("apertures", JSONArray((c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES) ?: FloatArray(0)).map { it.toDouble() }))
        j.put("torch", c.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true)
        val stabModes = c.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES) ?: IntArray(0)
        j.put("stab", CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON in stabModes)
        val awb = c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES) ?: IntArray(0)
        j.put("wb", JSONArray(WB.filter { it.value in awb }.keys.toList()))
        j.put("portrait", Build.VERSION.SDK_INT >= 31 && try {
            CameraExtensionCharacteristics.EXTENSION_BOKEH in cameraManager.getCameraExtensionCharacteristics(id).supportedExtensions
        } catch (e: Exception) { false })
        j.put("modes", JSONArray(streamModes(c)))
        j.put("facings", JSONArray(cameraManager.cameraIdList.mapNotNull {
            when (cameraManager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING)) {
                CameraCharacteristics.LENS_FACING_FRONT -> "front"
                CameraCharacteristics.LENS_FACING_BACK -> "back"
                else -> null
            }
        }.distinct()))
        return j
    }

    /** 16:9 "WxH@fps" combos the sensor, the encoder and the fps ranges all support. */
    private fun streamModes(c: CameraCharacteristics): List<String> {
        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return emptyList()
        val sizes = map.getOutputSizes(MediaCodec::class.java)?.toSet().orEmpty()
        val fpsRanges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES) ?: emptyArray()
        val vc = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
            .filter { it.isEncoder && it.supportedTypes.any { t -> t.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } }
            .sortedByDescending { it.isHardwareAccelerated }
            .firstOrNull()?.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)?.videoCapabilities
        val out = mutableListOf<String>()
        for ((w, h) in listOf(3840 to 2160, 2560 to 1440, 1920 to 1080, 1280 to 720)) {
            val sz = Size(w, h)
            if (sz !in sizes) continue
            for (f in listOf(30, 60)) {
                if (fpsRanges.none { it.upper == f }) continue
                if (map.getOutputMinFrameDuration(MediaCodec::class.java, sz) > 1_000_000_000L / f + 100_000) continue
                if (vc != null && !vc.areSizeAndRateSupported(w, h, f.toDouble())) continue
                out += "${w}x$h@$f"
            }
        }
        return out
    }

    /** Camera runs only while someone looks: the phone preview, or a PC that asked for frames. */
    private fun reconcile(rebuild: Boolean = false) {
        val want = preview != null || (conn != null && demand)
        when {
            want && device == null -> if (!opening) openCamera()
            !want && device != null -> { closeCamera(); publish() }
            want && rebuild -> startSession()
        }
    }

    @SuppressLint("MissingPermission")
    private fun openCamera() {
        val id = camId ?: return
        opening = true
        val gen = ++openGen
        try {
            cameraManager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(d: CameraDevice) {
                    opening = false
                    if (gen != openGen) { d.close(); reconcile(); return }
                    device = d
                    startSession()
                    publish()
                }
                override fun onDisconnected(d: CameraDevice) = lost(d)
                override fun onError(d: CameraDevice, error: Int) = lost(d)
            }, cam)
        } catch (e: Exception) {
            Log.w(TAG, "openCamera", e)
            opening = false
        }
    }

    /** Another app took the camera. [availability] reopens it once it is free again. */
    private fun lost(d: CameraDevice) {
        opening = false
        d.close()
        if (device === d) { device = null; teardownSession(); publish() }
    }

    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraAvailable(id: String) {
            if (id == camId && device == null && !opening) reconcile()
        }
    }

    private fun closeCamera() {
        openGen++
        teardownSession()
        device?.close()
        device = null
    }

    private fun teardownSession() {
        sessGen++
        session?.let {
            try { it.stopRepeating(); it.abortCaptures() } catch (_: Exception) {}
            it.close()
        }
        session = null
        extSession?.let { try { it.stopRepeating(); it.close() } catch (_: Exception) {} }
        extSession = null
        encoder?.let { try { it.stop() } catch (_: Exception) {}; it.release() }
        encoder = null
        encSurface?.release()
        encSurface = null
        csd = null
    }

    private fun startSession() {
        val d = device ?: return
        teardownSession()
        val gen = sessGen
        val (w, h) = state.optString("res", "1920x1080").split('x').map { it.toInt() }
        val fps = state.optInt("fps", 30)
        val mbps = state.optInt("mbps", 0).takeIf { it > 0 } ?: max(4, (w.toLong() * h * fps * 0.15 / 1e6).roundToInt())
        val enc: MediaCodec
        val es: Surface
        try {
            enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            enc.setCallback(encCallback, Handler(encThread.looper))
            enc.configure(MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, mbps * 1_000_000)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                setInteger(MediaFormat.KEY_PRIORITY, 0)
            }, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            es = enc.createInputSurface()
            enc.start()
        } catch (e: Exception) {
            Log.e(TAG, "encoder", e)
            return
        }
        encoder = enc
        encSurface = es

        val portrait = state.optString("mode") == "portrait" && caps.optBoolean("portrait") && Build.VERSION.SDK_INT >= 31
        try {
            if (portrait) {
                // ponytail: extension sessions take a single output, so the phone shows no preview in portrait mode.
                d.createExtensionSession(ExtensionSessionConfiguration(
                    CameraExtensionCharacteristics.EXTENSION_BOKEH, listOf(OutputConfiguration(es)), camExec,
                    object : CameraExtensionSession.StateCallback() {
                        override fun onConfigured(s: CameraExtensionSession) {
                            if (gen != sessGen) { try { s.close() } catch (_: Exception) {}; return }
                            extSession = s
                            applyControls()
                        }
                        override fun onConfigureFailed(s: CameraExtensionSession) {
                            Log.w(TAG, "bokeh session failed, falling back to video")
                            if (gen == sessGen) { state.put("mode", "video"); startSession(); publish() }
                        }
                    }))
            } else {
                val outs = listOfNotNull(es, preview).map { OutputConfiguration(it) }
                d.createCaptureSession(SessionConfiguration(SessionConfiguration.SESSION_REGULAR, outs, camExec,
                    object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            if (gen != sessGen) { s.close(); return }
                            session = s
                            applyControls()
                        }
                        override fun onConfigureFailed(s: CameraCaptureSession) { Log.e(TAG, "session config failed") }
                    }))
            }
        } catch (e: Exception) {
            Log.e(TAG, "session", e)
        }
    }

    private fun applyControls() {
        val d = device ?: return
        val es = encSurface ?: return
        try {
            val ext = extSession
            if (ext != null) {
                val b = d.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                b.addTarget(es)
                b.set(CaptureRequest.CONTROL_ZOOM_RATIO, state.optDouble("zoom", 1.0).toFloat())
                ext.setRepeatingRequest(b.build(), camExec, object : CameraExtensionSession.ExtensionCaptureCallback() {})
            } else {
                val s = session ?: return
                val b = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
                b.addTarget(es)
                preview?.let { b.addTarget(it) }
                fill(b)
                s.setRepeatingRequest(b.build(), captureCb, cam)
            }
        } catch (e: Exception) {
            Log.w(TAG, "controls", e)
        }
    }

    private fun fill(b: CaptureRequest.Builder) {
        val s = state
        val c = caps
        val fps = s.optInt("fps", 30)
        b.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
        b.set(CaptureRequest.CONTROL_ZOOM_RATIO, s.optDouble("zoom", 1.0).toFloat())
        chars?.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
            ?.filter { it.upper == fps }?.maxByOrNull { it.lower }
            ?.let { b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
        if (c.optBoolean("torch")) b.set(CaptureRequest.FLASH_MODE,
            if (s.optBoolean("torch")) CameraMetadata.FLASH_MODE_TORCH else CameraMetadata.FLASH_MODE_OFF)
        if (c.optBoolean("stab")) b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
            if (s.optBoolean("stab")) CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_ON
            else CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF)
        if (s.optString("mode") == "pro" && c.optBoolean("manual") && s.has("iso") && s.has("exp")) {
            val frame = 1_000_000_000L / fps
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF)
            b.set(CaptureRequest.SENSOR_SENSITIVITY, s.getInt("iso"))
            b.set(CaptureRequest.SENSOR_EXPOSURE_TIME, min(s.getLong("exp"), frame))
            b.set(CaptureRequest.SENSOR_FRAME_DURATION, frame)
        } else {
            b.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_ON)
            b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, s.optInt("ev"))
        }
        if (c.optBoolean("af") && s.optBoolean("af", true)) {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
        } else {
            b.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF)
            if (c.optDouble("focusMax") > 0) b.set(CaptureRequest.LENS_FOCUS_DISTANCE, s.optDouble("focus").toFloat())
        }
        WB[s.optString("wb")]?.let { b.set(CaptureRequest.CONTROL_AWB_MODE, it) }
        val aps = c.optJSONArray("apertures")
        if (aps != null && aps.length() > 1 && s.has("aperture")) b.set(CaptureRequest.LENS_APERTURE, s.getDouble("aperture").toFloat())
    }

    private val captureCb = object : CameraCaptureSession.CaptureCallback() {
        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, res: TotalCaptureResult) {
            res.get(CaptureResult.LENS_FOCUS_DISTANCE)?.let { lastFocus = it }
            res.get(CaptureResult.SENSOR_SENSITIVITY)?.let { lastIso = it }
            res.get(CaptureResult.SENSOR_EXPOSURE_TIME)?.let { lastExp = it }
        }
    }

    // ---------------------------------------------------------------- encoder

    private val encCallback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {}
        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {}
        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) { Log.e(TAG, "encoder", e) }
        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                val buf = codec.getOutputBuffer(index)
                if (buf != null && info.size > 0) {
                    val data = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(data, 0, info.size)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        csd = data
                        conn?.send(T_CONFIG, data)
                    } else if (live) {
                        conn?.sendFrame(info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0, info.presentationTimeUs, data)
                    }
                }
                codec.releaseOutputBuffer(index, false)
            } catch (_: IllegalStateException) {
                // codec released on the cam thread mid-callback
            }
        }
    }

    private fun requestKey() {
        try {
            encoder?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (_: Exception) {}
    }

    // ---------------------------------------------------------------- network

    private fun serve() {
        try {
            val ss = ServerSocket()
            ss.reuseAddress = true
            ss.bind(InetSocketAddress(TCP_PORT))
            server = ss
            while (running) {
                val s = ss.accept()
                s.tcpNoDelay = true
                s.soTimeout = 8000 // PC pings every 2 s
                s.sendBufferSize = 1 shl 20
                val c = Conn(s)
                cam.post {
                    conn?.close()
                    conn = c
                    c.start()
                }
            }
        } catch (e: IOException) {
            if (running) Log.e(TAG, "server", e)
        }
    }

    private fun linkAddr(net: Network) =
        connectivity.getLinkProperties(net)?.linkAddresses?.firstOrNull { it.address is Inet4Address }

    private fun ipInt(la: LinkAddress) = ByteBuffer.wrap(la.address.address).int

    private fun maskOf(la: LinkAddress) = if (la.prefixLength == 0) 0 else -1 shl (32 - la.prefixLength)

    private fun addr(ip: Int): InetAddress = InetAddress.getByAddress(ByteBuffer.allocate(4).putInt(ip).array())

    /** Leaving Wi-Fi range or switching networks ends the session, unless the PC is on USB. */
    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(n: Network) {
            val prev = wifiNet
            wifiNet = n
            if (prev != null && prev != n) leaveIfWireless("Wi-Fi network changed")
            publish() // the pairing code changes with the address
        }
        override fun onLost(n: Network) {
            if (n == wifiNet) { wifiNet = null; leaveIfWireless("Wi-Fi lost") }
        }
    }

    private fun leaveIfWireless(why: String) {
        if (conn?.usb == true) return
        Log.i(TAG, "stopping: $why")
        quit()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_IMMUTABLE)
        val quit = PendingIntent.getService(this, 1, Intent(this, CamService::class.java).setAction(ACTION_QUIT), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Open Dock Camera")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null as Icon?, "Quit", quit).build())
            .build()
    }

    /** One PC link: a writer thread drains [q], a reader thread feeds JSON into [handle]. */
    private inner class Conn(private val sock: Socket) {
        val usb: Boolean = sock.inetAddress.isLoopbackAddress
        private val q = LinkedBlockingQueue<Pair<Int, ByteArray>>()
        private val queuedFrames = AtomicInteger()
        @Volatile private var waitKey = true
        @Volatile private var closed = false
        @Volatile private var authed = false

        fun start() {
            thread(name = "tx", isDaemon = true) { tx() }
            thread(name = "rx", isDaemon = true) { rx() }
        }

        fun send(type: Int, data: ByteArray) { if (!closed && authed) q.offer(type to data) }

        fun sendJson(j: JSONObject) = send(T_JSON, j.toString().toByteArray())

        fun sendFrame(key: Boolean, ptsUs: Long, data: ByteArray) {
            if (key) waitKey = false
            if (waitKey) return
            if (queuedFrames.get() > 8) {
                // Link can't keep up: drop until the next keyframe instead of building latency.
                waitKey = true
                cam.post { requestKey() }
                return
            }
            queuedFrames.incrementAndGet()
            send(T_FRAME, ByteBuffer.allocate(9 + data.size).put((if (key) 1 else 0).toByte()).putLong(ptsUs).put(data).array())
        }

        private fun tx() {
            try {
                val out = DataOutputStream(BufferedOutputStream(sock.getOutputStream(), 1 shl 16))
                while (!closed) {
                    val (type, data) = q.take()
                    if (type < 0) break
                    if (type == T_FRAME) queuedFrames.decrementAndGet()
                    out.writeByte(type)
                    out.writeInt(data.size)
                    out.write(data)
                    if (q.isEmpty()) out.flush()
                }
            } catch (_: Exception) {
            } finally {
                close()
            }
        }

        private fun rx() {
            try {
                val inp = DataInputStream(BufferedInputStream(sock.getInputStream()))
                while (!closed) {
                    val type = inp.readUnsignedByte()
                    val len = inp.readInt()
                    if (len < 0 || len > (1 shl 20)) break
                    val data = ByteArray(len)
                    inp.readFully(data)
                    if (type == T_JSON) {
                        val j = JSONObject(String(data))
                        if (!authed) {
                            // Only the paired PC may watch: its first message carries the pairing key.
                            if (j.optString("t") != "auth" || token.isEmpty() || j.optString("token") != token) break
                            authed = true
                            cam.post { if (conn === this@Conn) { csd?.let { send(T_CONFIG, it) }; publish() } }
                            continue
                        }
                        cam.post { if (conn === this@Conn) handle(j) }
                    }
                }
            } catch (_: Exception) {
            } finally {
                close()
            }
        }

        fun close() {
            if (closed) return
            closed = true
            try { sock.close() } catch (_: IOException) {}
            q.offer(-1 to ByteArray(0))
            cam.post {
                if (conn === this@Conn) {
                    conn = null
                    demand = false
                    reconcile()
                    publish()
                }
            }
        }
    }
}
