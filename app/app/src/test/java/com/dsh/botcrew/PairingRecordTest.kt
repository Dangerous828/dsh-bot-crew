package com.dsh.botcrew

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 配好的电脑在盘上怎么存、怎么读回来。
 *
 * 这层映射出错不会报错，只会表现成「每次启动都要重新配对」或者「某条路静默消失」——
 * 后者尤其难查：P2P 明明公布过，App 却永远走局域网。所以每一格都钉一遍，
 * 包括老装机留下的、还没有后两格的记录。
 *
 * SharedPreferences 本身在 JVM 单测里跑不了，所以这里测的是它前后那份纯映射。
 */
class PairingRecordTest {

    private val saved = PairedCrew(
        deviceId = "dev-1",
        token = "tok-1",
        base = "http://192.168.31.127:43499",
        fallbackBase = "https://crew.example.top",
        p2pAddr = "tcpAAAA",
    )

    // 存一次读回来必须一模一样，三条路一格不少。
    @Test
    fun aSavedCrewComesBackWithAllThreeRoutes() {
        val back = PairingRecord.read(PairingRecord.write(saved))
        assertEquals(saved, back)
    }

    // 每一格都得真的写下去：少写一格，读的时候不会报错，只是那条路从此不存在。
    @Test
    fun everyFieldTheReaderWantsIsWritten() {
        val values = PairingRecord.write(saved)
        assertEquals("dev-1", values[PairingRecord.DEVICE])
        assertEquals("tok-1", values[PairingRecord.TOKEN])
        assertEquals("http://192.168.31.127:43499", values[PairingRecord.BASE])
        assertEquals("https://crew.example.top", values[PairingRecord.FALLBACK])
        assertEquals("tcpAAAA", values[PairingRecord.P2P])
    }

    // 老装机存下来的只有前三格：后两格读成空串（= 那台电脑没有那条路），不是读失败。
    @Test
    fun aRecordWrittenBeforeThoseFieldsExistedStillLoads() {
        val old = mapOf<String, Any?>(
            PairingRecord.DEVICE to "dev-1",
            PairingRecord.TOKEN to "tok-1",
            PairingRecord.BASE to "http://192.168.31.127:43499",
        )
        assertEquals(PairedCrew("dev-1", "tok-1", "http://192.168.31.127:43499"), PairingRecord.read(old))
        assertEquals("", PairingRecord.read(old)?.fallbackBase)
        assertEquals("", PairingRecord.read(old)?.p2pAddr)
    }

    // 前三格少一格就不算一份配对：宁可回到配对屏，也不要拿着半份凭据去连。
    @Test
    fun aRecordWithoutAnAddressIsNotAPairing() {
        val noBase = mapOf<String, Any?>(PairingRecord.DEVICE to "dev-1", PairingRecord.TOKEN to "tok-1")
        assertNull(PairingRecord.read(noBase))
        assertNull(PairingRecord.read(mapOf(PairingRecord.TOKEN to "tok-1", PairingRecord.BASE to "http://a")))
        assertNull(PairingRecord.read(mapOf(PairingRecord.DEVICE to "dev-1", PairingRecord.BASE to "http://a")))
        assertNull(PairingRecord.read(emptyMap()))
    }

    // 盘上存的类型不对（比如某次手改过）就当没有：SharedPreferences 的值不归我们保证。
    @Test
    fun aValueOfTheWrongTypeIsTreatedAsMissing() {
        val broken = mapOf<String, Any?>(
            PairingRecord.DEVICE to 42,
            PairingRecord.TOKEN to "tok-1",
            PairingRecord.BASE to "http://a",
        )
        assertNull(PairingRecord.read(broken))
    }
}
