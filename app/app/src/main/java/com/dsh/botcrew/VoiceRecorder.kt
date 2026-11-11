package com.dsh.botcrew

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

/**
 * 一句话的录音：16kHz 单声道 16 位，按 WAV 交给后端。
 *
 * 为什么自己录而不用系统语音识别：后端那台机器上已经有本地识别器（sherpa-onnx），
 * 音频过去就出字，不出本机；用系统识别反而要问它要文字、还得信它不上传。
 *
 * 采样率固定 16k：识别器就吃这个，录 44.1k 过去还要在那边重采样一遍，白花时间。
 */
class VoiceRecorder {

    private var record: AudioRecord? = null
    private var worker: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile private var stopped = true

    /** 设备能不能录：没有麦克风、或者采样率不被支持时为 false。 */
    @SuppressLint("MissingPermission")
    fun available(): Boolean = try {
        val size = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        size > 0
    } catch (_: Exception) {
        false
    }

    /**
     * 开始录。已经录着时什么也不做 —— 连点两下麦克风不该录出两段叠在一起的音频。
     * 调用方负责先要到 `RECORD_AUDIO` 权限：没有权限时这里会抛 SecurityException。
     */
    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        if (!stopped) return false
        val size = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (size <= 0) return false
        val created = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, CHANNEL, ENCODING, size * 2)
        } catch (_: Exception) {
            return false
        }
        if (created.state != AudioRecord.STATE_INITIALIZED) {
            created.release()
            return false
        }
        pcm.reset()
        record = created
        stopped = false
        created.startRecording()
        worker = thread(isDaemon = true, name = "voice-record") {
            val buffer = ByteArray(size)
            // 一直读到 stop() 或超时：一次最长 MAX_SECONDS，再长转出来的字也没人读。
            val deadline = System.currentTimeMillis() + MAX_MS
            while (!stopped && System.currentTimeMillis() < deadline) {
                val read = try { created.read(buffer, 0, buffer.size) } catch (_: Exception) { -1 }
                if (read > 0) synchronized(pcm) { pcm.write(buffer, 0, read) }
                else if (read < 0) break
            }
        }
        return true
    }

    /** 停录并把手上的采样包成 WAV。没在录时返回一个空的 WAV（而不是 null），让调用方少一个分支。 */
    fun stop(): ByteArray {
        if (stopped) return wavOf(ByteArray(0))
        stopped = true
        try { worker?.join(1500) } catch (_: InterruptedException) { Thread.currentThread().interrupt() }
        worker = null
        record?.let {
            try { it.stop() } catch (_: Exception) { }
            it.release()
        }
        record = null
        val samples = synchronized(pcm) { pcm.toByteArray() }
        pcm.reset()
        return wavOf(samples)
    }

    /** 已经录了多久（毫秒）。界面据此画那根进度，不用自己再记一个计时器。 */
    fun isRecording(): Boolean = !stopped

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** 一次最多录两分钟：与后端的上限对齐，超了那边也会拒。 */
        const val MAX_SECONDS = 120
        const val MAX_MS = MAX_SECONDS * 1000L

        /** 给 PCM 套一个 44 字节的 WAV 头。后端只收 WAV，原始 PCM 过去会说「不是 WAV」。 */
        fun wavOf(samples: ByteArray): ByteArray {
            val byteRate = SAMPLE_RATE * 1 * 2
            val out = ByteArrayOutputStream(44 + samples.size)
            fun u32(value: Int) {
                out.write(value and 0xFF)
                out.write((value shr 8) and 0xFF)
                out.write((value shr 16) and 0xFF)
                out.write((value shr 24) and 0xFF)
            }
            fun u16(value: Int) {
                out.write(value and 0xFF)
                out.write((value shr 8) and 0xFF)
            }
            out.write("RIFF".toByteArray())
            u32(36 + samples.size)
            out.write("WAVE".toByteArray())
            out.write("fmt ".toByteArray())
            u32(16)
            u16(1)
            u16(1)
            u32(SAMPLE_RATE)
            u32(byteRate)
            u16(2)
            u16(16)
            out.write("data".toByteArray())
            u32(samples.size)
            out.write(samples)
            return out.toByteArray()
        }
    }
}

/** 语音这一屏上的说法。纯函数，测试直接钉住。 */
object VoiceCopy {
    const val NEED_PERMISSION = "要用麦克风得先允许录音"
    const val NO_MIC = "这台设备没有可用的麦克风"
    const val LISTENING = "在听…再按一下结束"
    const val TOO_SHORT = "太短了，没听清"
    const val TRANSCRIBING = "正在认字…"
    const val INSERTED = "听写好了，看看对不对再发"

    /** 录音时长的那行字：`12 秒`。负数或读不出来时不写。 */
    fun duration(ms: Long): String {
        if (ms <= 0) return ""
        val seconds = (ms + 500) / 1000
        return "$seconds 秒"
    }

    /** 太短的不送：半秒以下基本是误触，送去认也只会回一句「没听出字」。 */
    fun tooShort(ms: Long): Boolean = ms < MIN_MS

    const val MIN_MS = 500L
}
