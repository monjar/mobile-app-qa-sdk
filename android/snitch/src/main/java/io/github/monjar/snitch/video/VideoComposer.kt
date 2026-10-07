/*
 * Composes the clip at send time (spec §5.7): the frozen JPEG frames become a
 * 10 fps H.264 MP4 with touch trails.
 *
 * - Schedule: the pure ClipSchedule twin — output frame k (at start + k·100 ms)
 *   shows the newest source frame at or before it. Each source JPEG is decoded
 *   once, drawn (fit-centre) into one reused ARGB canvas sized to the first frame
 *   rounded down to multiples of 16, then the trails are drawn on top.
 * - Encoder: MediaCodec `video/avc`, COLOR_FormatYUV420Flexible, input through
 *   getInputImage() (YuvWriter honours plane strides), KEY_FRAME_RATE 10,
 *   KEY_I_FRAME_INTERVAL 1, 1.2 Mbps, explicit presentationTimeUs = k·100 000.
 *   If the default (usually hardware) encoder fails to configure — or fails
 *   mid-way — the whole clip is retried once on the software encoder
 *   (c2.android.avc.encoder / OMX.google.h264.encoder).
 * - MediaMuxer MPEG_4, then Mp4FastStart puts `moov` before `mdat` so the clip
 *   streams. Runs on the SDK's I/O thread; never on the main thread.
 */
package io.github.monjar.snitch.video

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import io.github.monjar.snitch.SnitchLog
import io.github.monjar.snitch.capture.Frame
import io.github.monjar.snitch.capture.TouchSample
import io.github.monjar.snitch.capture.setRange
import io.github.monjar.snitch.logic.ClipSchedule
import java.io.File
import java.io.IOException
import kotlin.math.max
import kotlin.math.min

internal class VideoResult(val file: File, val width: Int, val height: Int, val durationMs: Long, val composeMs: Double)

internal object VideoComposer {
    private const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
    private const val FPS = 10
    private const val FRAME_US = 1_000_000L / FPS
    private const val BIT_RATE = 1_200_000
    private const val TIMEOUT_US = 10_000L
    private const val EOS_TIMEOUT_MS = 10_000L
    private val SOFTWARE_ENCODERS = listOf("c2.android.avc.encoder", "OMX.google.h264.encoder")

    /** Returns null when there is nothing to compose or every encoder failed. */
    fun compose(frames: List<Frame>, touches: List<TouchSample>, start: Long, end: Long, out: File): VideoResult? {
        if (frames.isEmpty() || end <= start) return null
        val t0 = SystemClock.elapsedRealtime()
        val first = frames[0]
        val width = max(16, first.width / 16 * 16)
        val height = max(16, first.height / 16 * 16)
        val schedule = ClipSchedule.clipSchedule(LongArray(frames.size) { frames[it].t }, start, end, FPS.toDouble())
        if (schedule.isEmpty()) return null
        for (software in listOf(false, true)) {
            out.delete()
            try {
                encode(frames, touches, schedule, start, width, height, out, software)
                try {
                    Mp4FastStart.process(out)
                } catch (e: Exception) {
                    SnitchLog.warn("video: could not move moov to the front; keeping the clip as muxed", e)
                }
                return VideoResult(out, width, height, schedule.size * FRAME_US / 1000, (SystemClock.elapsedRealtime() - t0).toDouble())
            } catch (e: Throwable) {
                SnitchLog.warn("video: ${if (software) "software" else "default"} encoder failed", e)
            }
        }
        out.delete()
        return null
    }

    private fun createEncoder(format: MediaFormat, software: Boolean): MediaCodec {
        if (!software) {
            val codec = MediaCodec.createEncoderByType(MIME)
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                return codec
            } catch (e: Exception) {
                codec.release()
                throw e
            }
        }
        for (name in SOFTWARE_ENCODERS) {
            val codec = try {
                MediaCodec.createByCodecName(name)
            } catch (_: Exception) {
                continue
            }
            try {
                codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                return codec
            } catch (_: Exception) {
                codec.release()
            }
        }
        throw IOException("no software H.264 encoder")
    }

    private fun encode(
        frames: List<Frame>,
        touches: List<TouchSample>,
        schedule: IntArray,
        start: Long,
        width: Int,
        height: Int,
        out: File,
        software: Boolean,
    ) {
        val format = MediaFormat.createVideoFormat(MIME, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, BIT_RATE)
            setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val codec = createEncoder(format, software)
        var muxer: MediaMuxer? = null
        val canvasBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        var source: Bitmap? = null
        try {
            codec.start()
            val mux = MediaMuxer(out.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            muxer = mux
            val drain = Drain(codec, mux)
            val canvas = Canvas(canvasBitmap)
            val paint = Paint(Paint.FILTER_BITMAP_FLAG)
            val dst = RectF()
            val argb = IntArray(width * height)
            val yuv = YuvWriter(width, height)
            val trails = TouchTrails(touches)
            val decodeOptions = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
            var sourceIndex = -1

            for (k in schedule.indices) {
                val frame = frames[schedule[k]]
                if (schedule[k] != sourceIndex) {
                    source?.recycle()
                    source = BitmapFactory.decodeByteArray(frame.jpeg, 0, frame.jpeg.size, decodeOptions)
                        ?: throw IOException("undecodable frame")
                    sourceIndex = schedule[k]
                }
                val src = source ?: throw IOException("no source frame")
                val fit = min(width / src.width.toFloat(), height / src.height.toFloat())
                val dw = src.width * fit
                val dh = src.height * fit
                val dx = (width - dw) / 2f
                val dy = (height - dh) / 2f
                dst.set(dx, dy, dx + dw, dy + dh)
                canvas.drawColor(Color.BLACK)
                canvas.drawBitmap(src, null, dst, paint)
                trails.draw(canvas, start + k * (FRAME_US / 1000), frame, fit, dx, dy)
                canvasBitmap.getPixels(argb, 0, width, 0, 0, width, height)

                val index = drain.dequeueInput()
                val image = codec.getInputImage(index) ?: throw IOException("encoder has no input image")
                yuv.write(image, argb)
                codec.queueInputBuffer(index, 0, width * height * 3 / 2, k * FRAME_US, 0)
                drain.drain(endOfStream = false)
            }
            val eos = drain.dequeueInput()
            codec.queueInputBuffer(eos, 0, 0, schedule.size * FRAME_US, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            drain.drain(endOfStream = true)
            if (drain.samples == 0) throw IOException("encoder produced no samples")
            codec.stop()
            mux.stop()
        } finally {
            source?.recycle()
            canvasBitmap.recycle()
            try {
                codec.release()
            } catch (_: Exception) {
            }
            try {
                muxer?.release()
            } catch (_: Exception) {
            }
        }
    }

    private class Drain(private val codec: MediaCodec, private val muxer: MediaMuxer) {
        private val info = MediaCodec.BufferInfo()
        private var track = -1
        var samples = 0
            private set

        fun dequeueInput(): Int {
            val deadline = SystemClock.elapsedRealtime() + EOS_TIMEOUT_MS
            while (true) {
                val index = codec.dequeueInputBuffer(TIMEOUT_US)
                if (index >= 0) return index
                drain(endOfStream = false)
                if (SystemClock.elapsedRealtime() > deadline) throw IOException("encoder input stalled")
            }
        }

        fun drain(endOfStream: Boolean) {
            val deadline = SystemClock.elapsedRealtime() + EOS_TIMEOUT_MS
            while (true) {
                val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0L)
                when {
                    index == MediaCodec.INFO_TRY_AGAIN_LATER -> {
                        if (!endOfStream) return
                        if (SystemClock.elapsedRealtime() > deadline) throw IOException("encoder did not finish")
                    }
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        if (track >= 0) throw IOException("output format changed twice")
                        track = muxer.addTrack(codec.outputFormat)
                        muxer.start()
                    }
                    index >= 0 -> {
                        val buffer = codec.getOutputBuffer(index)
                        if ((info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) info.size = 0
                        if (info.size > 0 && buffer != null) {
                            if (track < 0) throw IOException("sample before output format")
                            buffer.setRange(info.offset, info.offset + info.size)
                            muxer.writeSampleData(track, buffer, info)
                            samples++
                        }
                        codec.releaseOutputBuffer(index, false)
                        if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return
                    }
                    // INFO_OUTPUT_BUFFERS_CHANGED (pre-21 API) and anything else: ignore.
                }
            }
        }
    }
}
