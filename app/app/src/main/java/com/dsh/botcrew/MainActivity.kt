package com.dsh.botcrew

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    // 模拟器里 10.0.2.2 指向宿主机；真机换成本机局域网地址。
                    val client = CrewClient(
                        base = BuildConfig.GW_BASE,
                        token = BuildConfig.GW_TOKEN,
                    )
                    CrewRoot(client)
                }
            }
        }
    }
}

