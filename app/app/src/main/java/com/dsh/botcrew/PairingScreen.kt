package com.dsh.botcrew

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.launch

/**
 * 第一屏：还没配过电脑时要看到的东西。
 *
 * 方向是电脑出码、手机念码。所以要先把「去哪台电脑」说清楚，再只留一个六位数的输入框 ——
 * 中间填地址那种事不该让用户在手机上做。
 */
@Composable
fun PairingScreen(palette: CrewPalette, deviceId: String, context: android.content.Context, onPaired: (PairedCrew) -> Unit) {
    // 预填一台默认的：换电脑才需要改，第一次打开不该先让人去找 IP。
    var address by remember { mutableStateOf(BuildConfig.GW_BASE) }
    // 地址是不是人自己改过。自动填只在没改过时发生 —— 见 CrewNearby.autoPick。
    var touched by remember { mutableStateOf(false) }
    // 同一个 Wi-Fi 里找到的队伍。一台一台往里并，丢了就摘掉（按服务名去重）。
    val spots = remember { mutableStateListOf<CrewNearby.Spot>() }
    // 上一种「发现关了」的原因：没权限 / 什么都没找到。都不是错误，只说明「这条路今天不通，手输还在」。
    var discoveryOff by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var trouble by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // Android 13 起，「看见附近的设备」是运行时权限：清单里声明了也不够，不问系统就静默找不到服务。
    // 只在 13+ 问；问过被拒就退回手输，不再反复弹。
    // 用 Context 自带的 checkSelfPermission（API 23 起就有，minSdk 是 26），不额外拉一个依赖。
    fun permitted(): Boolean = !CrewNearby.needsPermission(Build.VERSION.SDK_INT) ||
        context.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) ==
        PackageManager.PERMISSION_GRANTED

    // 权限的当前看法。启动时先信系统记着的那份，问过之后以回调给的为准。
    var granted by remember { mutableStateOf(permitted()) }
    // 问过没有。存进 saveable：转个屏不该再弹一次 —— 被拒的人再被弹一次只会觉得这 App 烦。
    // 他要给可以去系统设置里给，那边给了、下次进这一屏 permitted() 就是 true，发现会自己回来。
    var settled by rememberSaveable { mutableStateOf(false) }
    // 再点一次「再找一次」时用这个数把发现那一轮重开。
    var discoveryTry by remember { mutableStateOf(0) }

    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        settled = true
    }

    // 进来先问一次：只在 13+、还没给过、也还没问过的时候。
    LaunchedEffect(Unit) {
        if (!settled && CrewNearby.needsPermission(Build.VERSION.SDK_INT) && !permitted()) {
            settled = true
            askPermission.launch(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
    }

    // 拿不到权限就根本不启动发现：启动了也只是空跑一趟 NSD，还以为「这网里没有队伍」。
    // 这里不用 collectLatest：那是「后一条把前一条取消掉」，最后只有一台活下来 ——
    // 同网段几台队伍就成了只剩一台。用 collect，每来一条都并进表里。
    LaunchedEffect(discoveryTry, granted) {
        if (!granted) {
            discoveryOff = NearbyCopy.NO_PERMISSION
            return@LaunchedEffect
        }
        // 重开一轮：旧表要清空，留着会和新发现叠成同名两行。
        // 「没找到」那句先不擦 —— 擦掉按钮会跟着消失，再找一次这件事就闪没了。
        if (discoveryOff == NearbyCopy.NO_PERMISSION) discoveryOff = null
        spots.clear()
        // 这一路会一直跑到系统停掉发现（或界面离开）；到那时才轮到下面那行。
        CrewDiscovery.find(context).collect { sighting ->
            val merged = CrewNearby.merge(spots.toList(), sighting)
            spots.clear()
            spots.addAll(merged)
        }
        // 一路收完还是一台都没见过：这句只是说明，不是错误；手输地址一直在。
        if (spots.isEmpty()) discoveryOff = NearbyCopy.NONE_FOUND
    }

    // 自动填：只有一台、且人没动过地址框时才填。多台就交给下面那几行，让人自己挑。
    // 键用整张表而不只是条数：同一台换了端口（地址变了）时也要跟上。
    LaunchedEffect(spots.toList(), touched) {
        val pick = CrewNearby.autoPick(spots.toList(), touched) ?: return@LaunchedEffect
        if (!CrewNearby.holds(address, pick.base)) address = pick.base
    }

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

        // 上面那行字：找到了几台、或者为什么没在找。三种情况各自一句话，淡色，不是错误。
        // 只有一台时「已填好」要地址确实等于它；多台时看地址落在哪一行 —— 人点过一台就不该再催他选。
        val picked = spots.firstOrNull { CrewNearby.holds(address, it.base) }
        val filled = spots.size == 1 && picked != null
        val note: String? = when {
            spots.size == 1 -> NearbyCopy.one(spots[0].name, filled)
            spots.size > 1 -> NearbyCopy.several(spots.size, picked?.name)
            else -> discoveryOff
        }
        note?.let {
            Text(
                it,
                fontSize = 12.sp,
                color = palette.muted,
                modifier = Modifier.fillMaxWidth().padding(bottom = 10.dp),
            )
        }

        OutlinedTextField(
            value = address,
            onValueChange = {
                // 人一动手，自动填就永久让位；之后再有台广播过来也不抢。
                touched = true
                address = it
            },
            label = { Text("电脑地址") },
            placeholder = { Text("http://192.168.31.127:8788") },
            singleLine = true,
            // 不吃 Material 的默认色：暗色下那套默认值会让文字几乎看不见。
            colors = crewFieldColors(palette),
            modifier = Modifier.fillMaxWidth(),
        )

        // 多台时列在这儿，点哪行填哪行。人点的是自己的明确选择，可以覆盖手改过的地址。
        // 被选中的那行给一道强调色的边：行本身就能说清「现在连的是哪一台」，
        // 不必再在上面那句话里换个说法重讲一遍。
        CrewNearby.rows(spots.toList(), address).forEach { spot ->
            val chosen = CrewNearby.holds(address, spot.base)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp)
                    .border(
                        1.dp,
                        if (chosen) palette.accent else palette.line,
                        RoundedCornerShape(10.dp),
                    )
                    .clickable {
                        touched = true
                        address = spot.base
                    }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        spot.name,
                        fontSize = 13.sp,
                        color = palette.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(spot.base, fontSize = 11.sp, color = palette.muted, maxLines = 1)
                }
                Spacer(Modifier.width(8.dp))
                Text("用它", fontSize = 12.sp, color = palette.accent)
            }
        }

        // 一台都没有时给一个重试的入口：换了 Wi-Fi 回来、或者刚去系统设置里给了权限，
        // 不用退出重进这一屏。按下去只是重新看一眼权限、重开一轮发现 —— 不会再弹系统框。
        if (spots.isEmpty() && discoveryOff != null) {
            TextButton(onClick = {
                granted = permitted()
                discoveryTry += 1
            }) {
                Text("再找一次", fontSize = 12.sp, color = palette.accent)
            }
        }

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
                        // 配对时顺手把「出门那条路」记下来：它和局域网地址是同一条 mDNS 记录给的，
                        // 人不用再输第二遍。没发现到（手填地址进来的）就是空串，只在本机附近可用。
                        val public = spots.firstOrNull { CrewNearby.holds(address, it.base) }?.publicBase.orEmpty()
                        onPaired(PairedCrew(credential.deviceId, credential.token, base, public))
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
