# 旧基线 APK（pre-r1）SharedPreferences 文件名 / key schema（静态只读提取）

来源（只读、静态反编译，未连设备、未读 App 沙箱 private prefs）：
`docs/review/cellular-20261115/baseline-apk/botcrew-Redmi-old-31e96-pre-r1.apk`
sha256 `31e96cd6eb6ef0fe5584ce519ef1b383066cd26c7c8b113b8cb47b51c7ba57a8`（已核对一致）
工具：apktool d -r（仅反编译 smali，未运行 APK）。包 `com.dsh.botcrew` 0.1.0/1。

## 一、SharedPreferences 文件（共 3 个，文件名精确匹配）

| prefs 文件名 | 定义处 | 用途 |
|---|---|---|
| `crew-pairing` | `PairingStore` (const `"crew-pairing"`) | 配对身份 + 选路三元组 + 停在哪会话 |
| `crew-permission` | `PermissionStore` (const `"crew-permission"`) | 运行时权限已请求/授权状态 |
| `crew-notices` | `NoticeStore` (const `"crew-notices"`) | 通知/告警去重与持久 |

> `crew-debug` / `crew-debug-conn` **不是** SharedPreferences —— 是 `CrewDebugServer` 的 `LocalServerSocket` 抽象命名空间名（调试 socket），别当成 prefs 文件。

## 二、`crew-pairing` key schema（核心，App 选路/配对身份都在这）

存取经 `PairingRecord`（`read(Map)` / `write(PairedCrew)` / `writeForSave(PairedCrew, session)` / `session(Map)`），落盘是**扁平 key**（getAll() 直接读，不是嵌套 `values`；`"values"` 只是 `checkNotNullParameter` 的形参标签）。

`write()` 固定 7 个 key（数组 size=7）：

| key | 类型 | 含义 | 缺省/读取行为 |
|---|---|---|---|
| `deviceId` | String | 设备号（配对签发） | 缺 → `PairedCrew` 该字段空 |
| `token` | String | 设备凭据 | 缺 → 空 |
| `base` | String | 局域网入口（配对时地址） | 缺 → `""` |
| `fallbackBase` | String | **出门公网入口（pub）** | 缺 → `""`（→ 出门只剩 LAN，不可达 = 「出门用不了」根因假设的落点） |
| `p2pAddr` | String | tailcat tc-addr（P2P 直连） | 缺 → `""` |
| `crew` | String | stateDir 指纹（认同一台机器） | 缺 → `""` |
| `session` | String | 上次停在哪个会话 | 缺/空 → 回落 **`"main"`**（`PairingRecord.session()`：get `"session"`，非 String 或空 check-cast 失败即 `main`） |

- `load()` 里 `PairedCrew` 的构造默认（未从 prefs 读到时的占位）：`base` 默认常量 `"http://10.0.2.2:43499"`（模拟器宿主机口径）经 `CrewPairing.normalize` 归一；`deviceId`/`token` 等默认 `""`。
- `saveSession(String)` 单独写 `session` key。
- **注意**：read() 逐 key `Map.get(key)` + `instance-of String` 判型；非 String 视作缺省。没有 legacy `paired` JSON blob 兼容——`"paired"` 只是 `checkNotNullParameter` 形参名，不是存储 key。

## 三、`crew-notices` key

| key | 类型 | 含义 |
|---|---|---|
| `fresh` | String | 新鲜通知游标（getString 读） |
| `persisted` | String | 已持久化通知账（`putString("persisted", …)`） |

（`NoticeStore` 用 `getAll()` 读全量 + 上述两 key 落库。）

## 四、`crew-permission` key

`PermissionStore` 用 `getAll()`（Map）存取，无固定单键字面量常量在 smali 层暴露；键按权限名动态（运行时权限名作 key）。若需精确到权限键，需读设备实际 prefs_loaded 才有值——本轮静态无法枚举（权限名由 API 动态传入）。

## 五、对「升级保配对」的意义（给 owner 参考，不含本人数据）

> ⚠️ **证据边界（必须遵守）**：本节只说明「代码路径存在」。**我们从未读取 pre-r1 该机的私有 prefs 真实值**（基线只见配对页、未登录设备读 private prefs；当前设备数据已被重新保存），因此**不能据此断定「该机当时 `fallbackBase` 为空」或「从未配对」是实机已证根因**。以下关于旧包表现的描述是**假设/代码可产生的路径**，不是该机当时的值。

- **代码路径（已由 smali 证实存在）**：升级 r1 后只要 `crew-pairing` 里 `deviceId`+`token`+`crew` 仍在，即保留配对身份；`fallbackBase`/`p2pAddr`/`base` 三种入口分存，**任一项缺失只影响对应那条路**，不破坏配对。
- **假设（未证实该机当时值）**：若某机旧包 `fallbackBase=""` 而 `deviceId/token` 在，则该机会表现为「在家（LAN base 通）正常、出门（fallbackBase 空）用不了」。这是**代码可产生的路径**，**未证实本机 pre-r1 当时的真实 prefs 值**；不得作为「该机出门故障」的定论根因。是否补齐 `fallbackBase` 也以实机取值为准，不据此断言。
- `session` 默认 `main`，force-stop 后 `prefs_loaded` 自动恢复 main 与 schema 一致，无需重配（此条为 schema 事实，非根因断言）。

**已真证的结论（与本文件 schema 无关的另证）**：当前配对持久 / 重启免配已实测成立；跨网（r2 覆盖）待补证。本文件不把「从未配对」或「旧 fallback 空」列为定论。
