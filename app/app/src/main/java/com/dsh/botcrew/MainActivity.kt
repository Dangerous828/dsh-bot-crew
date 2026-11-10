package com.dsh.botcrew

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 配好的电脑存在本机，重启后不用再念一次码。
        val pairing = PairingStore(this)
        val thisDevice = deviceId(this)

        setContent {
            val palette = if (isSystemInDarkTheme()) DarkPalette else LightPalette
            // 显式标类型：PairingStore.load 返回的是平台类型，推断不出来会让整段编译失败。
            var paired by remember { mutableStateOf(pairing.load()) }

            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    val current = paired
                    if (current == null) {
                        PairingScreen(palette, thisDevice) { credential ->
                            // 配好就落盘，下一帧直接进队伍。
                            pairing.save(credential)
                            paired = credential
                        }
                    } else {
                        CrewRoot(
                            client = CrewClient(current.base, current.token, current.deviceId),
                            palette = palette,
                            onForget = {
                                pairing.clear()
                                paired = null
                            },
                        )
                    }
                }
            }
        }
    }
}
