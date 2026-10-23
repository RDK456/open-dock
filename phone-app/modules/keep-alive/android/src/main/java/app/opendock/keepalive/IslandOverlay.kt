package app.opendock.keepalive

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.sin

/**
 * The voice island: a black pill at the top of the screen, over every app, while a voice command is heard and run.
 * Drawn by Android itself (a system overlay), so it shows while Open Dock is in the background. Needs "Display over
 * other apps"; without it nothing is shown.
 */
object IslandOverlay {
  private val main = Handler(Looper.getMainLooper())
  private var island: IslandView? = null

  fun show(context: Context, state: String, text: String) = main.post {
    val app = context.applicationContext
    if (!Settings.canDrawOverlays(app)) return@post
    val view = island ?: IslandView(app).also { created ->
      val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
      val params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        PixelFormat.TRANSLUCENT,
      ).apply {
        gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        y = created.dp(10)
      }
      try { windowManager(app).addView(created, params) } catch (_: Exception) { return@post }
      created.enter()
      island = created
    }
    view.update(state, text)
  }

  fun hide(context: Context) = main.post {
    val view = island ?: return@post
    island = null
    view.leave { try { windowManager(context.applicationContext).removeView(view) } catch (_: Exception) {} }
  }

  private fun windowManager(context: Context) = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
}

private class IslandView(context: Context) : LinearLayout(context) {
  private val wave = WaveView(context)
  private val label = TextView(context).apply {
    setTextColor(Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    paint.isFakeBoldText = true
    maxLines = 1
    ellipsize = TextUtils.TruncateAt.END
    maxWidth = dp(240)
  }

  init {
    orientation = HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    minimumHeight = dp(44)
    setPadding(dp(16), dp(8), dp(20), dp(8))
    background = GradientDrawable().apply { setColor(Color.BLACK); cornerRadius = dp(22).toFloat() }
    elevation = dp(6).toFloat()
    addView(wave, LayoutParams(dp(30), dp(22)).apply { marginEnd = dp(12) })
    addView(label)
  }

  fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

  fun update(state: String, text: String) {
    label.text = text.ifEmpty { if (state == "working") "Working…" else "Listening…" }
    wave.state = state
  }

  fun enter() {
    alpha = 0f; scaleX = 0.55f; scaleY = 0.4f
    animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(380).setInterpolator(OvershootInterpolator(1.6f)).start()
  }

  fun leave(done: () -> Unit) {
    wave.state = "idle"
    animate().alpha(0f).scaleX(0.55f).scaleY(0.4f).setDuration(200).withEndAction(done).start()
  }
}

/** Five bars that rise and fall while listening, slow while working, and rest in green or red at the end. */
private class WaveView(context: Context) : View(context) {
  private val colors = intArrayOf(0xFF5EF0B8.toInt(), 0xFF6FD6FF.toInt(), 0xFF8FB4FF.toInt(), 0xFFB59BFF.toInt(), 0xFFFF8AD8.toInt())
  private val offsets = floatArrayOf(0f, 2.1f, 0.9f, 2.8f, 1.4f)
  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val bar = RectF()
  private var phase = 0f
  private val ticker = ValueAnimator.ofFloat(0f, (2 * Math.PI).toFloat()).apply {
    duration = 900
    repeatCount = ValueAnimator.INFINITE
    addUpdateListener { phase = it.animatedValue as Float; invalidate() }
  }

  var state = "listening"
    set(value) {
      field = value
      val moving = value == "listening" || value == "working"
      ticker.duration = if (value == "working") 1600 else 900
      if (moving && !ticker.isStarted) ticker.start() else if (!moving) ticker.cancel()
      invalidate()
    }

  override fun onDetachedFromWindow() {
    ticker.cancel()
    super.onDetachedFromWindow()
  }

  override fun onDraw(canvas: Canvas) {
    val gap = width / 5f
    val barWidth = gap * 0.6f
    for (index in 0 until 5) {
      val level = when (state) {
        "listening", "working" -> 0.25f + 0.75f * ((sin(phase + offsets[index]) + 1f) / 2f)
        else -> 0.55f
      }
      paint.color = when (state) { "done" -> colors[0]; "failed" -> 0xFFFF7A90.toInt(); else -> colors[index] }
      paint.alpha = if (state == "working") 180 else 255
      val h = height * level
      val left = index * gap + (gap - barWidth) / 2
      bar.set(left, (height - h) / 2, left + barWidth, (height + h) / 2)
      canvas.drawRoundRect(bar, barWidth / 2, barWidth / 2, paint)
    }
  }
}
