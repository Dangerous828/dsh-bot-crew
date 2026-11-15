package com.dsh.botcrew

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 第一屏：还没配过电脑时要看到的东西。
 *
 * 方向是电脑出码、手机念码。所以要先把「去哪台电脑」说清楚，再只留一个六位数的输入框 ——
 * 中间填地址那种事不该让用户在手机上做。
 */
@Composable
fun PairingScreen(palette: CrewPalette, deviceId: String, context: android.content.Context, onPaired: (PairedCrew) -> Unit) {
    // 地址这一格的全部状态（含「人动过没有」）。屏幕里不再有第二个能改地址的变量 ——
    // 见 AddressField：所有非自动填的转移都会置 touched，所以「手改不被抢」不是靠记得写一行。
    var field by remember { mutableStateOf(AddressField.start(BuildConfig.GW_BASE)) }
    // 同一个 Wi-Fi 里找到的队伍。一台一台往里并，丢了就摘掉（按服务名去重）。
    val spots = remember { mutableStateListOf<CrewNearby.Spot>() }
    // 上一种「发现关了」的原因：没权限 / 什么都没找到。都不是错误，只说明「这条路今天不通，手输还在」。
    var discoveryOff by remember { mutableStateOf<String?>(null) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var trouble by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // 「问过没有」要跨 composable 生命周期成立（#34）。放持久层，不放 rememberSaveable：
    // 后者在「重新配对」重新进场时不会恢复，于是每次回来都再弹一次系统框。
    val permissions = remember { PermissionStore(context) }
    var asked by remember { mutableStateOf(permissions.asked()) }

    // Android 13 起，「看见附近的设备」是运行时权限：清单里声明了也不够，不问系统就静默找不到服务。
    // 只在 13+ 问；问过被拒就退回手输，不再反复弹。
    // 用 Context 自带的 checkSelfPermission（API 23 起就有，minSdk 是 26），不额外拉一个依赖。
    fun permitted(): Boolean = !CrewNearby.needsPermission(Build.VERSION.SDK_INT) ||
        context.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) ==
        PackageManager.PERMISSION_GRANTED

    // 权限的当前看法。启动时先信系统记着的那份，问过之后以回调给的为准。
    var granted by remember { mutableStateOf(permitted()) }
    // 再点一次「再找一次」时用这个数把发现那一轮重开。
    var discoveryTry by remember { mutableStateOf(0) }
    // 这一行的「沉默时长」要跟着时间走：表格进来时记一次，之后每几秒重算一遍。
    // 它只影响小字与「点它前先确认」，**不**用来摘行（#31 的结论）。
    var now by remember { mutableStateOf(SystemClock.elapsedRealtime()) }

    val askPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        // 回调已经发生过一次，就算「问过」了；被拒也不许因此再弹（#34）。
        asked = true
    }

    // 进来先问一次：只在 13+、还没给过、也还没问过的时候。判据是纯函数，见 CrewNearby.shouldAsk。
    LaunchedEffect(Unit) {
        if (!CrewNearby.shouldAsk(Build.VERSION.SDK_INT, permitted(), asked)) return@LaunchedEffect
        // 先落盘再弹：弹框那一刻起就算「问过」，进程被杀也不会退回去重弹一次。
        permissions.markAsked()
        asked = true
        askPermission.launch(Manifest.permission.NEARBY_WIFI_DEVICES)
    }

    // 有行在表里时才走这个钟：一台都没有时不空转。
    LaunchedEffect(spots.size) {
        if (spots.isEmpty()) return@LaunchedEffect
        while (true) {
            now = SystemClock.elapsedRealtime()
            delay(SILENCE_TICK_MS)
        }
    }

    // 拿不到权限就根本不启动发现：启动了也只是空跑一趟 NSD，还以为「这网里没有队伍」。
    // 这里不用 collectLatest：那是「后一条把前一条取消掉」，最后只有一台活下来 ——
    // 同网段几台队伍就成了只剩一台。用 collect，每来一条都并进表里。
    LaunchedEffect(discoveryTry, granted) {
        if (!granted) {
            // 问过且仍被拒：要说清「系统不会再弹」，否则人只会以为这 App 忘了（#34）。
            discoveryOff = if (asked) NearbyCopy.DENIED else NearbyCopy.NO_PERMISSION
            return@LaunchedEffect
        }
        // 重开一轮：旧表要清空，留着会和新发现叠成同名两行。
        // 「没找到」那句先不擦 —— 擦掉按钮会跟着消失，再找一次这件事就闪没了。
        if (discoveryOff == NearbyCopy.NO_PERMISSION || discoveryOff == NearbyCopy.DENIED) discoveryOff = null
        spots.clear()
        // 这一路会一直跑到系统停掉发现（或界面离开）；到那时才轮到下面那行。
        CrewDiscovery.find(context).collect { sighting ->
            // foundAt 取单调时钟：它是「多久没再响过」，与墙钟被改无关。
            val merged = CrewNearby.merge(spots.toList(), sighting, SystemClock.elapsedRealtime())
            spots.clear()
            spots.addAll(merged)
        }
        // 一路收完还是一台都没见过：这句只是说明，不是错误；手输地址一直在。
        if (spots.isEmpty()) discoveryOff = NearbyCopy.NONE_FOUND
    }

    // 自动填：只有一台、且人没动过地址框时才填。多台就交给下面那几行，让人自己挑。
    // 键用整张表而不只是条数：同一台换了端口（地址变了）时也要跟上。
    LaunchedEffect(spots.toList(), field.touched) {
        field = field.autoFilled(spots.toList())
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
        val picked = spots.firstOrNull { field.holds(it) }
        val filled = spots.size == 1 && picked != null
        val single = spots.singleOrNull()
        val note: String? = when {
            single != null -> NearbyCopy.one(
                single.name,
                filled = filled,
                // 手改过、而地址又不是这一台：那就是「找到它了，但地址是你自己填的」（#32）。
                handEdited = field.touched && !filled,
                staleSeconds = staleSeconds(single, now),
            )
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
            value = field.address,
            onValueChange = {
                // 人一动手，自动填就永久让位；之后再有台广播过来也不抢。
                // 置位在 AddressField.typed 里，不在这一行 —— 这样它才被测得到（#32）。
                field = field.typed(it)
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
        CrewNearby.rows(spots.toList(), field.address).forEach { spot ->
            val chosen = field.holds(spot)
            // 这一行有多久没再响过。它不改结论，也不摘行：只把「上次发现多久前」说出来（#31）。
            val silent = staleSeconds(spot, now)
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
                        field = field.picked(spot)
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
                    if (silent != null) {
                        Text(
                            NearbyCopy.staleRow(silent),
                            fontSize = 11.sp,
                            color = palette.warn,
                            maxLines = 1,
                        )
                    }
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
            enabled = !busy && field.address.isNotBlank() && code.length == 6,
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
                        val base = CrewPairing.normalize(field.address)
                        val spot = spots.firstOrNull { CrewNearby.holds(base, it.base) }
                        // 这一行已经有一阵没再响过：先握一次手，通了才提交那支码（#31）。
                        // 判据是 TCP 通不通这种可证伪的事实，不是「静了多久」的猜测 ——
                        // 静默时长只决定要不要多这一次握手，绝不决定摘不摘行。
                        if (spot != null && CrewNearby.needsCheck(spot, SystemClock.elapsedRealtime())) {
                            val alive = PairingClient(base).reachable()
                            if (!alive) {
                                // silence() 返回**毫秒**，age() 要的是**秒** —— 不除 1000 会把
                                // 「2 分钟前」显示成「33 小时前」（真机实测抓到，见 #31 收尾）。
                                trouble = "这台电脑上次发现于" +
                                    NearbyCopy.age(CrewNearby.silence(spot, SystemClock.elapsedRealtime()) / 1_000) +
                                    "，现在连不上。可能已经关了，换一台或核对地址再试。"
                                return@launch
                            }
                        }
                        val client = PairingClient(base)
                        val credential = client.pair(code, deviceId, deviceName(), "android")
                        // 配对时顺手把「出门那条路」「隧道那条路」和队伍指纹记下来：它们和
                        // 局域网地址是同一条 mDNS 记录给的，人不用再输第二遍。没发现到
                        // （手填地址进来的）就是空串，那时只剩局域网这一条，也不做刷新 ——
                        // 认不出是哪台队伍就不猜。
                        onPaired(PairedCrew(
                            credential.deviceId,
                            credential.token,
                            base,
                            spot?.publicBase.orEmpty(),
                            spot?.p2pAddr.orEmpty(),
                            spot?.crew.orEmpty(),
                        ))
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

/**
 * 这一行该说的「沉默多久」，只在**真的过门槛**时才返回秒数（#31）。
 *
 * 没过门槛返回 null：刚响过的行不该挂一句「上次发现 3 秒前」，那是噪音。
 * 判据在 [CrewNearby.stale]，这里只把毫秒换成给人看的秒。
 */
private fun staleSeconds(spot: CrewNearby.Spot, now: Long): Long? =
    if (CrewNearby.stale(spot, now)) CrewNearby.silence(spot, now) / 1_000 else null

/** 「沉默时长」重算的粒度。30 秒一跳就够：门槛本身是 30 秒。 */
private const val SILENCE_TICK_MS = 5_000L

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
