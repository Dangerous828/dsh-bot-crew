package com.dsh.botcrew

import java.io.IOException
import java.net.ServerSocket
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CrewClientPauseTest {
    private fun withReply(body: String, status: Int = 200, check: (CrewClient, () -> Triple<String, String, String>) -> Unit) {
        val request = AtomicReference<Triple<String, String, String>>()
        val server = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        server.soTimeout = 5_000
        val executor = Executors.newSingleThreadExecutor()
        val reply = executor.submit {
            server.accept().use { socket ->
                socket.soTimeout = 5_000
                val reader = socket.getInputStream().bufferedReader()
                val start = reader.readLine().split(" ")
                var length = 0
                while (true) {
                    val header = reader.readLine()
                    if (header.isEmpty()) break
                    if (header.startsWith("Content-Length:", ignoreCase = true)) {
                        length = header.substringAfter(':').trim().toInt()
                    }
                }
                val payload = CharArray(length)
                var read = 0
                while (read < length) {
                    val count = reader.read(payload, read, length - read)
                    require(count > 0)
                    read += count
                }
                request.set(Triple(start[0], start[1], String(payload)))
                val bytes = body.toByteArray()
                socket.getOutputStream().apply {
                    write("HTTP/1.1 $status Reply\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(bytes)
                    flush()
                }
            }
        }
        try {
            check(CrewClient(listOf("http://127.0.0.1:${server.localPort}"), "test-token")) { request.get() }
            reply.get(5, TimeUnit.SECONDS)
        } finally {
            server.close()
            executor.shutdownNow()
        }
    }

    @Test fun resumeRequiresExplicitExecutorReceiptAndPostsEmptyObject() {
        withReply("""{"ok":true,"resumed":true,"scope":"executor"}""") { client, request ->
            assertEquals("executor", runBlocking { client.resume() })
            val (method, path, body) = request()
            assertEquals("POST", method)
            assertEquals("/api/mobile/resume", path)
            assertEquals(0, JSONObject(body).length())
        }
    }

    @Test fun resumeDoesNotTreatIncompleteOrNegativeReceiptsAsSuccess() {
        for (body in listOf(
            "{}", """{"ok":false,"resumed":true,"scope":"executor"}""",
            """{"ok":true,"resumed":false,"scope":"executor"}""",
            """{"ok":true,"scope":"executor"}""",
            """{"ok":true,"resumed":true}""",
            """{"ok":true,"resumed":true,"scope":"ticket"}""",
            """{"ok":"true","resumed":true,"scope":"executor"}""",
            """{"ok":true,"resumed":"true","scope":"executor"}""",
        )) {
            withReply(body) { client, _ ->
                assertThrows(IOException::class.java) { runBlocking { client.resume() } }
            }
        }
    }

    @Test fun resumePropagatesHttpFailure() {
        withReply("resume failed", 503) { client, _ ->
            val failure = assertThrows(IOException::class.java) { runBlocking { client.resume() } }
            assertEquals(true, failure.message!!.contains("503"))
        }
    }

    @Test fun pauseUsesExistingOkAndScopeContractAndPreservesTicket() {
        withReply("""{"ok":true,"scope":"executor"}""") { client, request ->
            assertEquals("executor", runBlocking { client.pause("ticket-1") })
            val (method, path, body) = request()
            assertEquals("POST", method)
            assertEquals("/api/mobile/pause", path)
            assertEquals("ticket-1", JSONObject(body).getString("ticket"))
        }
    }

    @Test fun pauseWithoutTicketPostsEmptyObject() {
        withReply("""{"ok":true,"scope":"executor"}""") { client, request ->
            runBlocking { client.pause(null) }
            assertEquals(0, JSONObject(request().third).length())
        }
    }

    @Test fun pauseDoesNotInventSuccessOrScope() {
        for (body in listOf("{}", """{"ok":true}""", """{"ok":false,"scope":"executor"}""")) {
            withReply(body) { client, _ ->
                assertThrows(IOException::class.java) { runBlocking { client.pause(null) } }
            }
        }
    }
}
