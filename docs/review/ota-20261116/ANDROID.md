# Android OTA（App 内更新）

目标：手机不必再插 USB。更新包由发布脚本放到 `https://crew.kentonnie.top/updates/android/`，
App 自己检查、下载、校验，然后把安装交给系统确认。

## 入口

- 侧栏「工具 · 检查更新」→ 整页覆盖层（与「诊断」同一做法）：当前版本 / 可用版本 / 一个主动作。
- **未配对也能进**：配对屏底部同样有「检查更新」。新手机装第一个包走浏览器下载同签 APK 覆盖安装，
  之后就用这里的入口，不再需要电脑。
- 进页面时若距上次检查超过 6 小时会自动静默检查一次：只提示，不自动下载、不弹窗、不自动安装。

## 固定契约

`BuildConfig.OTA_MANIFEST_URL` 由 gradle 属性 `crewUpdateUrl` 注入，
缺省 `https://crew.kentonnie.top/updates/android/manifest.json`。

manifest 字段（`schemaVersion: 1`）：

| 字段 | 约束 |
|---|---|
| `packageName` | 必须等于本 App 的 applicationId（缺省 `com.dsh.botcrew`） |
| `schemaVersion` | 必须**正好** 1（按 Long 比，先 toInt 会被 2^32+1 溢出绕过） |
| `versionCode` | JSON 整数，`1..2100000000` |
| `versionName` | 非空、无首尾空格、≤64 |
| `buildId` | 非空、≤64 |
| `minSdk` | `21..1000`；大于设备 SDK 直接判不兼容 |
| `sha256` | 64 位**小写** hex |
| `size` | `1..268435456`（256 MiB） |
| `signerSha256` | 64 位小写 hex |
| `apkPath` | 必须逐字等于 `/updates/android/<versionCode>/<sha256>.apk` |
| `notes` | 可选，≤2000 |

- manifest 与 APK 必须 **HTTPS 同 origin**；APK 地址只由 manifest 的 origin + `apkPath` 拼成，
  manifest 里出现的其它 host 一律不采信。
- 重定向手动逐跳跟随（最多 3 跳），每一跳都要过同源检查。
- 更新通道**不带**任何既有配对 token/凭据，与 `CrewClient` 的请求完全分开。

## 状态与恢复

状态只有七种：`Idle / Checking / Available / Downloading / Verifying / Ready / Failed`，
全部由 `Ota`（纯 JVM）算出，`OtaRuntime` 只提供 Android 事实。

- 进页面、Activity 重建、从系统设置/安装器回来都走 `restore()`：按磁盘残量与持久记录重算
  （有下载/检查在途时不动状态，避免把「正在检查」闪回旧态）。
- 记录里存 `versionCode / size / sha256` 三件套；三者与磁盘残包不同源时（换版本、或同版本号重发
  换了内容）**先丢残包**再算状态，否则旧半截会被当新包续传。
  记录为空 → 空态；残量 < `size` → 「已暂停 · 可继续」；== `size` → 自动进校验。
- 校验通过后把 `versionCode:sha256` 记在 prefs，进程被杀也不丢：再进页面直接是「安装」，不必重下。
- 取消/失败都有明确出口，并保留 `.part` 供续传：界面上不会出现「永久下载中」。
- 已装版本 ≥ 记录版本（装成功了）→ 清记录与文件，回到空态。

## 下载

不用 DownloadManager，也不引新依赖：`HttpURLConnection` + `RandomAccessFile` 写到
`filesDir/ota/update.apk.part`。

- **206**：必须带 `Content-Range: bytes <start>-<end>/<total>`，且 `0 <= start <= end < total`、
  `start` == 续传起点、`total` == manifest 的 `size`、**`end` == `total - 1`**（我们的请求总是开放区间
  `bytes=<from>-`，服务端正确的回答只能是「一直续到末尾」）；任何一项不符都删残包、落失败。
  只查 start/total 会把被打断的一段当成整段接上去。
- **200**（服务端忽略了 Range）：**丢弃残包从 0 重写**，绝不追加。
- 写盘进度与校验读的是同一个文件，状态与磁盘永远一致。

取消：先让代际失效 → `job.cancel()` → `conn.disconnect()`（否则阻塞的 read 不会返回）。
下载槽位由 `invokeOnCompletion` 释放，**收尾之后**才允许起新的下载；旧协程晚到的进度/失败因代际不符
被丢弃。收尾前用户再点「继续下载」会被记住，收尾后自动补跑一次，不会白点。

## 校验（装之前，逐条）

1. 文件长度 == `size`
2. 文件 SHA-256 == `sha256`
3. `getPackageArchiveInfo`：包名 == manifest 包名、`longVersionCode` == `versionCode`
4. 本机已装包名 == manifest 包名，且 manifest 版本 > 已装版本（拒绝降级）
5. APK 实际签名集合 == `PackageManager` 读到的**当前已装**签名集合
6. manifest 的 `signerSha256` ∈ 实际签名集合

任何一条不符都拒绝并删掉已下载文件。签名指纹在运行期从 PackageManager 读，
**代码里不硬编码任何证书摘要**（生产已装签名 `ad0e4480…40af7eb` 只作为发布验收的比对值）。

## 安装

- 清单声明 `REQUEST_INSTALL_PACKAGES`；未授权时页面只给一句「需要允许「安装未知应用」」，
  按钮变「去允许」跳系统设置页。
- 授权后点「安装」：先在 IO 线程**当场重验**长度/hash/包名/版本/签名（不信缓存标记，防权限往返或
  外部写入后拿被改过的文件去装），通过后 `FileProvider` 内容 URI + `application/vnd.android.package-archive`
  → `ACTION_VIEW` **交系统安装器**，确认框由系统弹。重验不过就删文件退回可下载态。
- 不静默安装、不自研安装器、不申请设备管理员。用户取消系统确认后仍是「已校验，可安装」，可再点。
- `FileProvider` 用**新建的** `res/xml/ota_paths.xml`，只暴露 `filesDir/ota/`；
  authority 为 `${applicationId}.ota`。不复活已删除的 `file_paths.xml`，不加录音权限。

## 版本号

`app/app/build.gradle.kts` 改为属性注入，保留既有 `crewBuildId / crewPublicBase / crewExpectedCrew /
crewAppId / crewGateway / crewToken / crewDevice / crewCredential / crewDiagBase`：

```
-PcrewVersionCode=3 -PcrewVersionName=0.3.0 [-PcrewBuildId=...] [-PcrewUpdateUrl=...]
```

缺省 `crewVersionCode=2` / `crewVersionName=0.2.0`。发布脚本按最新已发布版本递增 `crewVersionCode`。

## 测试

`app/app/src/test/java/com/dsh/botcrew/OtaPolicyTest.kt`（纯 JVM，23 例，均通过）钉住：
入口与 URL 约束、同源判定、manifest 全字段契约（含类型、范围、apkPath 自洽）、
`Content-Range` 起点/终点/总长、schema 溢出、字段边界（versionCode/size/minSdk/文本）、
残包归属（code+size+sha 三件套）、版本判定、安装候选一致性（长度/hash/包名/版本/签名）、
以及状态机在取消/失败/恢复后的出口。Android 相关（签名、PackageManager、FileProvider、Intent）
集中在 `OtaRuntime`，便于以后替换或加 instrumented 测试。

本轮实测：`OtaPolicyTest` 23 例 + 全仓 601 例通过（`:app:testDebugUnitTest`，JDK 21）。
另核对过 Gradle 注入：`-PcrewVersionCode=3 -PcrewVersionName=0.3.0 -PcrewBuildId=ota-20261116-r1`
产出 `VERSION_CODE=3 / VERSION_NAME="0.3.0"`，`-PcrewUpdateUrl=…` 覆盖 `OTA_MANIFEST_URL`，缺省回到 2 / 0.2.0。

验证命令（不产出发布物）：

```
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ./gradlew :app:testDebugUnitTest
```

## 服务端需要遵守

- `GET /updates/android/manifest.json` 未发布时返回 404（App 显示「暂无更新」，不是错误）。
- APK 必须支持 `Range`（返回 206 且 `Content-Range` 正确）；不支持则 App 每次从头重下，仍能装成功。
- manifest 与 APK 同一 origin、全 HTTPS；不要给 APK 加需要凭据的入口。
