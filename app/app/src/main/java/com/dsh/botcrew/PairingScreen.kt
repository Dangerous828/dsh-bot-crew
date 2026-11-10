package com.dsh.botcrew

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * 第一屏：还没配过电脑时要看到的东西。
 *
 * 方向是电脑出码、手机念码。所以要先把「去哪台电脑」说清楚，再只留一个六位数的输入框 ——
 * 中间填地址那种事不该让用户在手机上做。
 */
@Composable
fun PairingScreen(palette: CrewPalette, deviceId: String, onPaired: (PairedCrew) -> Unit) {
    // 预填一台默认的：换电脑才需要改，第一次打开不该先让人去找 IP。
    var address by remember { mutableStateOf(BuildConfig.GW_BASE) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var trouble by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // 键盘弹起时可用高度会变小。居中排列会让整列上移，点到的位置和看到的位置对不上 ——
    // 表现是「点配对码框，字进了地址框」。改成顶部对齐 + 可滚动 + 让出键盘高度。
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.surface)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Top,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(96.dp))
        Text("连接你的电脑", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = palette.ink)
        Text(
            "在电脑上点「配对手机」，把那六位数念进来。",
            fontSize = 13.sp,
            color = palette.muted,
            modifier = Modifier.padding(top = 8.dp, bottom = 22.dp),
        )

        OutlinedTextField(
            value = address,
            onValueChange = { address = it },
            label = { Text("电脑地址") },
            placeholder = { Text("http://192.168.31.127:8788") },
            singleLine = true,
            // 不吃 Material 的默认色：暗色下那套默认值会让文字几乎看不见。
            colors = crewFieldColors(palette),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = code,
            onValueChange = { if (it.length <= 6) code = it.filter(Char::isDigit) },
            label = { Text("配对码") },
            placeholder = { Text("六位数字") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            colors = crewFieldColors(palette),
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
        )

        trouble?.let {
            Text(it, color = palette.danger, fontSize = 12.sp, modifier = Modifier.padding(top = 10.dp))
        }

        Button(
            enabled = !busy && address.isNotBlank() && code.length == 6,
            // 禁用态在暗色下要和背景分得开，否则按钮像不存在。
            colors = ButtonDefaults.buttonColors(
                containerColor = palette.accent,
                contentColor = palette.surface,
                disabledContainerColor = palette.faint,
                disabledContentColor = palette.muted,
            ),
            onClick = {
                busy = true
                trouble = null
                scope.launch {
                    try {
                        // 人最常输的是 192.168.31.127:43499 这种不带协议的形式；不补 scheme，
                        // URL 构造会直接抛 MalformedURLException，配对永远不成立。
                        val base = CrewPairing.normalize(address)
                        val client = PairingClient(base)
                        val credential = client.pair(code, deviceId, deviceName(), "android")
                        onPaired(PairedCrew(credential.deviceId, credential.token, base))
                    } catch (error: Exception) {
                        trouble = error.message ?: "配对被拒绝"
                    } finally {
                        busy = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
        ) {
            if (busy) CircularProgressIndicator(modifier = Modifier.padding(end = 8.dp)) 
            Text(if (busy) "配对中" else "连上")
        }
    }
}

/** 输入框一套配色。Material 的默认值在暗色下会把地址文字压到几乎看不见。 */
@Composable
private fun crewFieldColors(palette: CrewPalette) = OutlinedTextFieldDefaults.colors(
    focusedTextColor = palette.ink,
    unfocusedTextColor = palette.ink,
    focusedBorderColor = palette.accent,
    unfocusedBorderColor = palette.faint,
    focusedLabelColor = palette.accent,
    unfocusedLabelColor = palette.muted,
    cursorColor = palette.accent,
)
