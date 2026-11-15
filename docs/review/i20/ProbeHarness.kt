// 直接调用产品代码里的 TailcatP2p.probe()，不复制、不改写任何探测逻辑。
// 判据：ok（隧道能不能承载真请求）、millis（稳态一个来回）、墙钟（预算是否真封住）。
import com.dsh.botcrew.TailcatP2p
import kotlin.system.exitProcess

fun main(args: Array<String>) {
    val port = args[0].toInt()
    val token = if (args.size > 1) args[1] else "i20-token"
    val waitMs = if (args.size > 2) args[2].toInt() else 15_000
    val rounds = if (args.size > 3) args[3].toInt() else 1
    repeat(rounds) { i ->
        val started = System.nanoTime()
        val probe = TailcatP2p.probe(port, token, null, waitMs)
        val wall = (System.nanoTime() - started) / 1_000_000
        println("ROUND $i ok=${probe.ok} millis=${probe.millis} wall_ms=$wall")
    }
    exitProcess(0)
}
