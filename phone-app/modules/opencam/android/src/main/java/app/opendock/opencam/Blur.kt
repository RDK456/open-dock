package app.opendock.opencam

import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.media.ImageReader
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.util.Size
import android.view.Surface
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/**
 * Background blur: the camera draws into [input] (a GL texture) and a small [reader] image; ML Kit's selfie
 * segmenter turns the small image into a person mask, and a shader mixes the sharp frame with a blurred copy
 * before it reaches the encoder and the phone preview. [rotation] is how far the frame turns clockwise to be upright.
 */
internal class Blur(private val w: Int, private val h: Int, encoder: Surface, private val preview: Surface?, maskSize: Size, rotation: Int) {
    private val thread = HandlerThread("blur").apply { start() }
    private val handler = Handler(thread.looper)
    private val onThread = Executor { handler.post(it) }
    val reader: ImageReader = ImageReader.newInstance(maskSize.width, maskSize.height, ImageFormat.YUV_420_888, 2)
    lateinit var input: Surface
        private set
    private lateinit var texture: SurfaceTexture
    private val segmenter = Segmentation.getClient(
        SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.STREAM_MODE).build()
    )
    @Volatile private var busy = false
    @Volatile private var closed = false
    private val rotation = rotation

    private var display = EGL14.EGL_NO_DISPLAY
    private var context = EGL14.EGL_NO_CONTEXT
    private var config: EGLConfig? = null
    private var encEgl = EGL14.EGL_NO_SURFACE
    private var prevEgl = EGL14.EGL_NO_SURFACE
    private var previewTries = 0
    private var camTex = 0
    private var smallTex = 0
    private var maskTex = 0
    private var fbo = 0
    private var downProg = 0
    private var mixProg = 0
    private val sw = maxOf(16, w / 10)
    private val sh = maxOf(9, h / 10)
    private var hasMask = false
    private val matrix = FloatArray(16)
    private val quad = ByteBuffer.allocateDirect(32).order(ByteOrder.nativeOrder()).asFloatBuffer()
        .apply { put(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)); position(0) }

    init {
        val done = CountDownLatch(1)
        handler.post {
            try { setup(encoder) } catch (e: Exception) { Log.e(TAG, "blur setup", e) }
            done.countDown()
        }
        done.await(2, TimeUnit.SECONDS)
        reader.setOnImageAvailableListener({ segment(it) }, handler)
    }

    /** True when the GL side came up; otherwise the caller streams without blur. */
    val ready get() = ::input.isInitialized && encEgl != EGL14.EGL_NO_SURFACE

    private fun setup(encoder: Surface) {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        EGL14.eglInitialize(display, version, 0, version, 1)
        val attribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT, EGL_RECORDABLE_ANDROID, 1, EGL14.EGL_NONE
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0)
        config = configs[0] ?: error("no EGL config")
        context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        encEgl = EGL14.eglCreateWindowSurface(display, config, encoder, intArrayOf(EGL14.EGL_NONE), 0)
        check(encEgl != EGL14.EGL_NO_SURFACE) { "encoder surface" }
        EGL14.eglMakeCurrent(display, encEgl, encEgl, context)

        val ids = IntArray(3)
        GLES20.glGenTextures(3, ids, 0)
        camTex = ids[0]; smallTex = ids[1]; maskTex = ids[2]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, camTex)
        linear(GLES11Ext.GL_TEXTURE_EXTERNAL_OES)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, smallTex)
        linear(GLES20.GL_TEXTURE_2D)
        GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, sw, sh, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
        linear(GLES20.GL_TEXTURE_2D)
        val f = IntArray(1)
        GLES20.glGenFramebuffers(1, f, 0)
        fbo = f[0]
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
        GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, smallTex, 0)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        downProg = program(VERTEX, DOWN)
        mixProg = program(VERTEX, MIX)

        texture = SurfaceTexture(camTex).apply {
            setDefaultBufferSize(w, h)
            setOnFrameAvailableListener({ draw() }, handler)
        }
        input = Surface(texture)
    }

    private fun linear(target: Int) {
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    }

    private fun program(vs: String, fs: String): Int {
        fun shader(type: Int, src: String) = GLES20.glCreateShader(type).also {
            GLES20.glShaderSource(it, src)
            GLES20.glCompileShader(it)
            val ok = IntArray(1)
            GLES20.glGetShaderiv(it, GLES20.GL_COMPILE_STATUS, ok, 0)
            check(ok[0] != 0) { GLES20.glGetShaderInfoLog(it) }
        }
        return GLES20.glCreateProgram().also {
            GLES20.glAttachShader(it, shader(GLES20.GL_VERTEX_SHADER, vs))
            GLES20.glAttachShader(it, shader(GLES20.GL_FRAGMENT_SHADER, fs))
            GLES20.glBindAttribLocation(it, 0, "pos")
            GLES20.glLinkProgram(it)
        }
    }

    /** Runs ML Kit on the newest small frame; frames that arrive while it works are dropped. */
    private fun segment(r: ImageReader) {
        val image = r.acquireLatestImage() ?: return
        if (busy || closed) { image.close(); return }
        busy = true
        segmenter.process(InputImage.fromMediaImage(image, rotation))
            .addOnSuccessListener(onThread) { mask ->
                if (closed) return@addOnSuccessListener
                val floats = mask.buffer.apply { rewind() }
                val bytes = ByteBuffer.allocateDirect(mask.width * mask.height)
                repeat(mask.width * mask.height) { bytes.put((floats.float.coerceIn(0f, 1f) * 255f).toInt().toByte()) }
                bytes.position(0)
                EGL14.eglMakeCurrent(display, encEgl, encEgl, context)
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
                GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
                GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, mask.width, mask.height, 0, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, bytes)
                hasMask = true
            }
            .addOnCompleteListener(onThread) { image.close(); busy = false }
    }

    private fun draw() {
        if (closed) return
        try {
            EGL14.eglMakeCurrent(display, encEgl, encEgl, context)
            texture.updateTexImage()
            texture.getTransformMatrix(matrix)
            // Pass 1: a tenth-size copy; bilinear sampling of it is most of the blur.
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
            GLES20.glViewport(0, 0, sw, sh)
            GLES20.glUseProgram(downProg)
            bind(downProg)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
            // Pass 2: sharp person over the blurred room, to the encoder with the camera's timestamp.
            mix(w, h)
            EGLExt.eglPresentationTimeANDROID(display, encEgl, texture.timestamp)
            EGL14.eglSwapBuffers(display, encEgl)
            if (preview != null && prevEgl == EGL14.EGL_NO_SURFACE && previewTries++ < 60) {
                // The camera may still hold the preview for a moment after the last session closed.
                prevEgl = EGL14.eglCreateWindowSurface(display, config, preview, intArrayOf(EGL14.EGL_NONE), 0)
                if (prevEgl == EGL14.EGL_NO_SURFACE) EGL14.eglGetError()
            }
            if (prevEgl != EGL14.EGL_NO_SURFACE) {
                EGL14.eglMakeCurrent(display, prevEgl, prevEgl, context)
                EGL14.eglSwapInterval(display, 0)
                val size = IntArray(2)
                EGL14.eglQuerySurface(display, prevEgl, EGL14.EGL_WIDTH, size, 0)
                EGL14.eglQuerySurface(display, prevEgl, EGL14.EGL_HEIGHT, size, 1)
                mix(size[0], size[1])
                EGL14.eglSwapBuffers(display, prevEgl)
            }
        } catch (e: Exception) {
            Log.w(TAG, "blur frame", e)
        }
    }

    private fun mix(width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        GLES20.glUseProgram(mixProg)
        bind(mixProg)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, smallTex)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(mixProg, "small"), 1)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE2)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(mixProg, "mask"), 2)
        GLES20.glUniform2f(GLES20.glGetUniformLocation(mixProg, "px"), 1.5f / sw, 1.5f / sh)
        GLES20.glUniform1f(GLES20.glGetUniformLocation(mixProg, "rot"), (rotation / 90).toFloat())
        GLES20.glUniform1f(GLES20.glGetUniformLocation(mixProg, "on"), if (hasMask) 1f else 0f)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    }

    private fun bind(prog: Int) {
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, camTex)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(prog, "cam"), 0)
        GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(prog, "st"), 1, false, matrix, 0)
        GLES20.glEnableVertexAttribArray(0)
        GLES20.glVertexAttribPointer(0, 2, GLES20.GL_FLOAT, false, 0, quad)
    }

    /** Blocks until GL is gone, so the encoder and preview surfaces can be released after it. */
    fun release() {
        closed = true
        reader.setOnImageAvailableListener(null, null)
        val done = CountDownLatch(1)
        handler.post {
            try {
                segmenter.close()
                if (::texture.isInitialized) { texture.setOnFrameAvailableListener(null); texture.release(); input.release() }
                if (display != EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                    if (prevEgl != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, prevEgl)
                    if (encEgl != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, encEgl)
                    EGL14.eglDestroyContext(display, context)
                    EGL14.eglTerminate(display)
                }
            } catch (e: Exception) {
                Log.w(TAG, "blur release", e)
            }
            reader.close()
            done.countDown()
        }
        done.await(2, TimeUnit.SECONDS)
        thread.quitSafely()
    }

    companion object {
        private const val TAG = "OpenCamBlur"
        private const val EGL_RECORDABLE_ANDROID = 0x3142

        private const val VERTEX = """
            attribute vec2 pos;
            uniform mat4 st;
            varying vec2 uv;
            varying vec2 full;
            void main() {
                gl_Position = vec4(pos, 0.0, 1.0);
                full = pos * 0.5 + 0.5;
                uv = (st * vec4(full, 0.0, 1.0)).xy;
            }"""

        private const val DOWN = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES cam;
            varying vec2 uv;
            void main() { gl_FragColor = texture2D(cam, uv); }"""

        // uv is the camera buffer's own coordinate (row 0 at the top), the mask is upright: turn uv by rot quarter-turns.
        private const val MIX = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            uniform samplerExternalOES cam;
            uniform sampler2D small;
            uniform sampler2D mask;
            uniform vec2 px;
            uniform float rot;
            uniform float on;
            varying vec2 uv;
            varying vec2 full;
            void main() {
                vec4 sharp = texture2D(cam, uv);
                vec4 soft = vec4(0.0);
                for (int i = -1; i <= 1; i++)
                    for (int j = -1; j <= 1; j++)
                        soft += texture2D(small, full + vec2(float(i), float(j)) * px);
                soft /= 9.0;
                vec2 m = rot < 0.5 ? uv : rot < 1.5 ? vec2(1.0 - uv.y, uv.x) : rot < 2.5 ? vec2(1.0 - uv.x, 1.0 - uv.y) : vec2(uv.y, 1.0 - uv.x);
                float person = smoothstep(0.35, 0.75, texture2D(mask, m).r);
                gl_FragColor = mix(sharp, mix(soft, sharp, person), on);
            }"""
    }
}
