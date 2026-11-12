package com.dsh.botcrew

/**
 * tailcat C ABI 的 JNI 入口。
 *
 * 为什么把「库在不在」做成一个可读的属性而不是直接抛：包里只带 arm64 的 libtailcat.so ——
 * 真机是 arm64，模拟器不是。缺库时这台机器就没有 P2P 这条路，但局域网/公网两条照常能用，
 * 所以上层的判断是「这条路今天不通」，不是「App 坏了」。
 */
object TailcatNative {
    private const val LIBRARY = "tailcatjni"

    /** 与 [nativeAbiVersion] 必须是同一个数：符号在、语义变了，比没有这条路更难查。 */
    private const val ABI = 1

    /** 非空表示这台机器上没有 P2P 通道，内容是原因（写日志、显示在状态里）。 */
    val unavailable: String? = runCatching {
        System.loadLibrary(LIBRARY)
        // 隧道本体单独加载一次：它在 JNI 那一层也会 dlopen，但这里先探一次能让原因更具体 ——
        // 「库不在这台机器上」和「符号对不上」是两种不同的故障。
        System.loadLibrary("tailcat")
        val version = nativeAbiVersion()
        check(version == ABI) { "tailcat ABI 版本是 $version，这个 App 只认 $ABI" }
    }.exceptionOrNull()?.let { it.message ?: it.javaClass.simpleName }

    /** ABI 版本，这个调用不能失败（除到库不可用）。 */
    external fun nativeAbiVersion(): Int

    /** 建一个客户端句柄。address 是电脑 broadcast 出来的 tc-addr（内嵌密钥，别写进日志）。 */
    external fun nativeClientNew(address: String): Long

    /**
     * 在隧道里连到电脑的 [port]，拿到一条真 TCP 流。
     *
     * [timeoutMs] 是这个动作的总期限（含注册与路径发现）；0 表示不设期限。
     */
    external fun nativeDial(client: Long, port: Int, timeoutMs: Int): Long

    /** 读一段。返回字节数；-1 表示对端发了 FIN。 */
    external fun nativeRead(connection: Long, buffer: ByteArray): Int

    /** 写完 [length] 个字节。返回实际写出去的数量。 */
    external fun nativeWrite(connection: Long, buffer: ByteArray, length: Int): Int

    /** 关掉写端（发 FIN）而保留读。 */
    external fun nativeCloseWrite(connection: Long)

    /** 释放句柄。对同一个句柄重复调用是安全的。 */
    external fun nativeClose(handle: Long)
}
