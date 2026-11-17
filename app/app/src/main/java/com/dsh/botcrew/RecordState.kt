package com.dsh.botcrew

/**
 * 盘上一条记录读回来的三态。与 [PairingRecord.ReadState] 同一条规矩：
 * 「没有」和「读坏了」不是一件事 —— 把损坏当成空，下一次写就会把用户还没发出去的东西覆盖掉。
 */
enum class RecordState { MISSING, OK, CORRUPT }

/**
 * 读结果：[items] 只在 [RecordState.OK] 时有意义；[raw] 是盘上原串，损坏时**原样**带回去。
 *
 * 调用方拿到 [RecordState.CORRUPT] 时必须：①不覆盖（别 put 回去）；②不发送（否则那一格账永远对不上）；
 * ③给一条看得见的提示。绝不静默当空。
 */
data class RecordRead<out T>(val state: RecordState, val items: List<T>, val raw: String) {
    val corrupt: Boolean get() = state == RecordState.CORRUPT
}

fun <T> recordRead(raw: String?, decode: (String) -> List<T>?): RecordRead<T> {
    if (raw.isNullOrEmpty()) return RecordRead(RecordState.MISSING, emptyList(), raw ?: "")
    val items = try {
        decode(raw)
    } catch (_: Exception) {
        null
    } ?: return RecordRead(RecordState.CORRUPT, emptyList(), raw)
    return RecordRead(RecordState.OK, items, raw)
}
