package app.opendock.keepalive

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.zip.InflaterInputStream

/**
 * Rebuilds the new APK from the installed one and a small patch, so an update downloads only what changed.
 * The format is scripts/make-delta.py's: bsdiff with zlib blocks. Streams everything, so memory stays small
 * however big the APK is. Returns the new file's SHA-256 (hex) for the caller to check against the release.
 */
object DeltaPatch {
  private val MAGIC = "ODPATCH1".toByteArray()

  fun apply(old: File, patch: File, out: File): String {
    val header = ByteArray(32)
    DataInputStream(FileInputStream(patch)).use { it.readFully(header) }
    require(header.copyOfRange(0, 8).contentEquals(MAGIC)) { "not an Open Dock patch" }
    val numbers = ByteBuffer.wrap(header, 8, 24).order(ByteOrder.LITTLE_ENDIAN)
    val newSize = numbers.long
    val ctrlLength = numbers.long
    val diffLength = numbers.long

    // Each block is read by its own stream, opened at the block's place in the patch.
    fun block(offset: Long): DataInputStream {
      val input = FileInputStream(patch)
      input.channel.position(32 + offset)
      return DataInputStream(BufferedInputStream(InflaterInputStream(BufferedInputStream(input)), 1 shl 16))
    }
    val digest = MessageDigest.getInstance("SHA-256")
    var written = 0L
    block(0).use { ctrl ->
      block(ctrlLength).use { diff ->
        block(ctrlLength + diffLength).use { extra ->
          RandomAccessFile(old, "r").use { source ->
            BufferedOutputStream(FileOutputStream(out), 1 shl 16).use { sink ->
              val oldLength = source.length()
              val triple = ByteArray(24)
              val buffer = ByteArray(1 shl 16)
              val oldBuffer = ByteArray(1 shl 16)
              var oldPos = 0L
              while (written < newSize) {
                try { ctrl.readFully(triple) } catch (_: EOFException) { break }
                val x = offtin(triple, 0)
                val y = offtin(triple, 8)
                val z = offtin(triple, 16)
                var left = x
                while (left > 0) {
                  val n = minOf(left, buffer.size.toLong()).toInt()
                  readFully(diff, buffer, n)
                  // Old bytes outside the file count as zero, as in bsdiff.
                  java.util.Arrays.fill(oldBuffer, 0, n, 0)
                  if (oldPos in 0 until oldLength) {
                    source.seek(oldPos)
                    source.readFully(oldBuffer, 0, minOf(n.toLong(), oldLength - oldPos).toInt())
                  }
                  for (i in 0 until n) buffer[i] = (buffer[i] + oldBuffer[i]).toByte()
                  sink.write(buffer, 0, n)
                  digest.update(buffer, 0, n)
                  oldPos += n
                  written += n
                  left -= n
                }
                left = y
                while (left > 0) {
                  val n = minOf(left, buffer.size.toLong()).toInt()
                  readFully(extra, buffer, n)
                  sink.write(buffer, 0, n)
                  digest.update(buffer, 0, n)
                  written += n
                  left -= n
                }
                oldPos += z
              }
            }
          }
        }
      }
    }
    require(written == newSize) { "the patch did not rebuild the whole file" }
    return hex(digest.digest())
  }

  fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(1 shl 16)
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        digest.update(buffer, 0, n)
      }
    }
    return hex(digest.digest())
  }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun readFully(input: InputStream, buffer: ByteArray, length: Int) {
    var at = 0
    while (at < length) {
      val n = input.read(buffer, at, length - at)
      if (n < 0) throw EOFException("the patch ended early")
      at += n
    }
  }

  // bsdiff's 8-byte sign-magnitude integer.
  private fun offtin(bytes: ByteArray, at: Int): Long {
    var value = bytes[at + 7].toLong() and 0x7F
    for (i in 6 downTo 0) value = (value shl 8) or (bytes[at + i].toLong() and 0xFF)
    return if (bytes[at + 7].toInt() and 0x80 != 0) -value else value
  }
}
