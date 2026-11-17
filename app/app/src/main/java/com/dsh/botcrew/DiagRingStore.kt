package com.dsh.botcrew

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * 诊断事件的**本地有界环形存储**：一行一条 JSON、追加写盘、超限丢最老、可读可清。
 * 另管一份**有界持久化的隔离集**（quarantine，服务端拒收 / 本地超限的毒记录 id+reasonCode）：
 * 与 ring 同在 diag 目录，跨进程/重建仍在（直到被 ring 淘汰或用户清理）。
 *
 * ## 为什么落盘而不是只放内存
 *
 * 断网时事件必须先留在本地，恢复后再批量补传——放内存里一杀进程就全丢。落 app 私有目录
 * （`filesDir/diag/ring.jsonl`），不需要加密：这里只存白名单字段（无 token/正文），本就是脱敏后的东西。
 *
 * ## 原子写（防真丢队列）
 *
 * 重写绝不「先删原文件再改名」——那正是 kill/rename 失败会把整个未 ACK 队列删没的根因。
 * 一律：写 tmp → `fd.sync()` 落盘 → `Files.move(tmp, file, ATOMIC_MOVE, REPLACE_EXISTING)` 原子替换。
 * 失败**显式抛**（不静默），原文件仍在，队列不丢；诊断页能据此暴露问题。
 * append 也在返回前 `fd.sync()`，crash 相关追加必须先 durable 才让 uncaught handler 往下走。
 *
 * ## 有界（硬边界，绝不无界增长）
 *
 * ring：[MAX_ROWS] 条 与 [MAX_BYTES] 字节，超限从最老丢。quarantine 也封顶 [MAX_QUARANTINE] 条 / [MAX_QUARANTINE_BYTES]，
 * 且 ring 淘汰某 id 时同步把它从 quarantine 移除（不留无主隔离项）。
 *
 * ## 线程
 *
 * 读写全程加锁：记录点来自 UI/网络 IO/未捕获异常处理器三处并发。
 */
class DiagRingStore internal constructor(private val dir: File) : DiagUploader.Store {

    constructor(context: Context) : this(File(context.filesDir, "diag").apply { if (!exists()) mkdirs() })

    private val file = File(dir, "ring.jsonl")
    private val sidecar = File(dir, "quarantine.jsonl")
    private val lock = Any()

    init { if (!dir.exists()) dir.mkdirs() }

    /** 读回当前全部事件（按写入顺序，最老在前）。坏行跳过，不让一条残行拖垮整个环。 */
    override fun readAll(): List<JSONObject> = synchronized(lock) {
        if (!file.exists()) return emptyList()
        val out = ArrayList<JSONObject>()
        file.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                if (line.isBlank()) continue
                try { out.add(JSONObject(line)) } catch (_: Throwable) { /* 残行跳过 */ }
            }
        }
        out
    }

    /** 追加一条（已序列化的）记录。返回前 fsync 落盘，再按上限收口。 */
    fun append(row: JSONObject) = synchronized(lock) {
        appendDurable(row.toString() + "\n")
        trimLocked()
    }

    /** 批量追加（崩溃 breadcrumbs 等）。一次 fsync，再 trim。 */
    fun appendAll(rows: List<JSONObject>) = synchronized(lock) {
        if (rows.isEmpty()) return
        appendDurable(rows.joinToString("") { it.toString() + "\n" })
        trimLocked()
    }

    /** 追加并 fsync。crash 路径用它保证 durable 后才 chain 原 handler。 */
    private fun appendDurable(text: String) {
        FileOutputStream(file, true).use { out ->
            out.write(text.toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
    }

    override fun removeIds(ids: Set<String>): Int = synchronized(lock) {
        if (ids.isEmpty() || !file.exists()) return 0
        val kept = ArrayList<String>()
        var removed = 0
        file.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                if (line.isBlank()) continue
                val id = try { JSONObject(line).optString("id") } catch (_: Throwable) { "" }
                if (id.isNotEmpty() && id in ids) removed++ else kept.add(line)
            }
        }
        if (removed > 0) rewriteLocked(kept)
        removed
    }

    fun clear() = synchronized(lock) {
        if (file.exists()) file.delete()
        if (sidecar.exists()) sidecar.delete()
    }

    fun stats(): Stats = synchronized(lock) {
        if (!file.exists()) return Stats(0, 0)
        var rows = 0
        file.bufferedReader(Charsets.UTF_8).useLines { lines -> for (line in lines) if (line.isNotBlank()) rows++ }
        Stats(rows, file.length())
    }

    data class Stats(val rows: Int, val bytes: Long)

    // ---- 有界持久隔离集（quarantine）----

    /** 读当前隔离 id 集（跨进程/重建仍在）。 */
    override fun quarantinedIds(): Set<String> = synchronized(lock) {
        if (!sidecar.exists()) return emptySet()
        val out = HashSet<String>()
        sidecar.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                if (line.isBlank()) continue
                try { JSONObject(line).optString("id").takeIf { it.isNotEmpty() }?.let { out.add(it) } } catch (_: Throwable) {}
            }
        }
        out
    }

    /** 把一批 (id, reasonCode) 记入隔离集；已存在的跳过。有界封顶，超限丢最老记入的。 */
    override fun addQuarantine(entries: List<Pair<String, String>>) = synchronized(lock) {
        if (entries.isEmpty()) return
        val existing = LinkedHashMap<String, String>()
        if (sidecar.exists()) {
            sidecar.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (line in lines) {
                    if (line.isBlank()) continue
                    try {
                        val o = JSONObject(line); val id = o.optString("id")
                        if (id.isNotEmpty()) existing[id] = o.optString("reason")
                    } catch (_: Throwable) {}
                }
            }
        }
        var added = false
        for ((id, reason) in entries) {
            if (id.isEmpty() || existing.containsKey(id)) continue
            existing[id] = reason.take(64)
            added = true
        }
        if (added) writeQuarantineLocked(existing)
    }

    private fun writeQuarantineLocked(map: LinkedHashMap<String, String>) {
        // 有界：超条数丢最老；超字节再按尾巴留。
        var items = map.entries.toList()
        if (items.size > MAX_QUARANTINE) items = items.takeLast(MAX_QUARANTINE)
        val lines = ArrayList<String>()
        var bytes = 0L
        for ((id, reason) in items.asReversed()) {
            val line = JSONObject().put("id", id).put("reason", reason).toString()
            val size = line.toByteArray(Charsets.UTF_8).size + 1
            if (bytes + size > MAX_QUARANTINE_BYTES && lines.isNotEmpty()) break
            bytes += size
            lines.add(line)
        }
        lines.reverse()
        atomicWrite(sidecar, lines)
    }

    /**
     * 原子重写 ring **或** sidecar：写 tmp → fd.sync → Files.move(ATOMIC_MOVE, REPLACE_EXISTING)。
     * **绝不先删原文件**；rename 失败显式抛，原文件仍在。空内容也用空 tmp 原子替换（不 delete 目标）。
     */
    private fun atomicWrite(target: File, lines: List<String>) {
        val tmp = File(dir, target.name + ".tmp")
        FileOutputStream(tmp).use { out ->
            if (lines.isNotEmpty()) out.write((lines.joinToString("\n") { it } + "\n").toByteArray(Charsets.UTF_8))
            out.flush()
            out.fd.sync()
        }
        try {
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (t: Throwable) {
            // 原子移动失败：清掉 tmp，保留原文件，显式抛给调用方（诊断可见），原队列不丢。
            tmp.delete()
            throw java.io.IOException("诊断存储原子替换失败（保留原队列）：${target.name}", t)
        }
    }

    private fun rewriteLocked(lines: List<String>) = atomicWrite(file, lines)

    private fun trimLocked() {
        if (!needTrim()) return
        val lines = file.bufferedReader(Charsets.UTF_8).useLines { it.filter { l -> l.isNotBlank() }.toList() }
        val rows = ArrayList<String>()
        var bytes = 0L
        // Leave room after saturation: 1s activity polling must not atomically rewrite the full ring on every append.
        val retainedRows = MAX_ROWS * 4 / 5
        val retainedBytes = MAX_BYTES * 4 / 5
        for (line in lines.asReversed()) {
            val size = line.toByteArray(Charsets.UTF_8).size + 1
            if (rows.size >= retainedRows) break
            if (bytes + size > retainedBytes && rows.isNotEmpty()) break
            bytes += size
            rows.add(line)
        }
        rows.reverse()
        rewriteLocked(rows)
        // ring 淘汰后可清理 quarantine 里已不存在于 ring 的 id（防无主隔离项无界）。
        pruneQuarantineToRingLocked()
    }

    private fun pruneQuarantineToRingLocked() {
        if (!sidecar.exists()) return
        val ringIds = HashSet<String>()
        if (file.exists()) {
            file.bufferedReader(Charsets.UTF_8).useLines { lines ->
                for (l in lines) {
                    if (l.isBlank()) continue
                    try { JSONObject(l).optString("id").takeIf { it.isNotEmpty() }?.let { ringIds.add(it) } } catch (_: Throwable) {}
                }
            }
        }
        val kept = LinkedHashMap<String, String>()
        var changed = false
        sidecar.bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                if (line.isBlank()) continue
                try {
                    val o = JSONObject(line); val id = o.optString("id")
                    if (id.isNotEmpty()) {
                        if (id in ringIds) kept[id] = o.optString("reason") else changed = true
                    }
                } catch (_: Throwable) {}
            }
        }
        if (changed) writeQuarantineLocked(kept)
    }

    private fun needTrim(): Boolean {
        if (!file.exists()) return false
        if (file.length() <= MAX_BYTES) {
            var n = 0
            file.bufferedReader(Charsets.UTF_8).useLines { ls ->
                for (l in ls) { if (l.isNotBlank()) n++; if (n > MAX_ROWS) return@useLines }
            }
            return n > MAX_ROWS
        }
        return true
    }

    companion object {
        /** 契约 §5.9 服务端每设备 5000 行是上限；本地只保最近一段，够诊断即可。 */
        const val MAX_ROWS = 500
        const val MAX_BYTES = 512L * 1024L
        /** 隔离集封顶：与 ring 同步有界，防无界。 */
        const val MAX_QUARANTINE = 500
        const val MAX_QUARANTINE_BYTES = 64L * 1024L
    }
}
