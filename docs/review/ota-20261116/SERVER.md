# Android OTA 服务端分发（2026-11-16）

手机要能自己装新版本，第一次得从网页下到同一个签名的 APK（不再插 USB）。所以现有的手机监听
（`lan-server`，43499；公网 `crew.kentonnie.top` 由 cloudflared 直连这个端口）上多开一片**不验凭据**
的区域，其余一字不动。

## 一、路由怎么接进来的

`createLanServer` 的 `handle` 里，在**凭据判定之前**认领这一片：

```ts
const path = (request.url ?? '/').split('?')[0] ?? '/'
if (updatesRoot && (path === UPDATE_PREFIX || path.startsWith(`${UPDATE_PREFIX}/`))) {
  await serveAndroidUpdate(request, response, updatesRoot)
  return
}
if (!path.startsWith('/api/mobile/')) { /* 404 */ }
// …presentedDevice + devices.allows → 401
```

- `updatesRoot` 是 `LanServerOptions` 的新可选字段；`index.ts` 传 `<machine.stateDir>/android-updates`。
- **不给这个字段就没有这片区域**：老行为一字不变（`tests/updates.spec.ts` 的最后一组钉住这一点）。
- 认领范围只到这一条前缀。它不是静态文件服务器：前缀之外仍然只有 `/api/mobile/*`，仍然要凭据。
- 公开的只有「包 + 指针」。目录、`state.db`、设备表、发布脚本之类都在前缀之外，取不到。

## 二、目录契约（发布 CLI 按这个写）

```
<stateDir>/android-updates/                分发根
  manifest.json                            唯一 latest 指针（原子写）
  <versionCode>/<sha256>.apk               不可变包：文件名自证内容
```

Root 的发布 CLI：先原子写 immutable APK（同目录临时文件 + rename），再原子更新 manifest。
**服务端不写、不改、不推导 manifest 的任何字段** —— 指针只有发布方一个写入者，
OTA 的「新版本」也因此只有一处定义。

## 三、HTTP 契约

方法只 `GET` / `HEAD`，其余 `405` + `Allow: GET, HEAD`。

| 地址 | 回应 |
|---|---|
| `GET/HEAD /updates/android/manifest.json` | `200` JSON；`cache-control: no-store` |
| `GET/HEAD /updates/android/<code>/<64hex>.apk` | `200`（整份）或 `206`（单区间）；`application/vnd.android.package-archive`，`Content-Length`，`Accept-Ranges: bytes`，`Content-Disposition: attachment; filename="com.dsh.botcrew-<code>.apk"`，`cache-control: public, max-age=31536000, immutable` |
| `GET /updates/android/latest.apk` | `302` → manifest 里的 `apkPath`；`no-store` |
| `GET /updates/android/`（及裸前缀） | `302` → `latest.apk`；不新建网页 |
| 未发布 | `404` |
| manifest 存在但不合契约 | `503` + `Retry-After: 60` |

`latest.apk` 是给浏览器首次启用 OTA 用的稳定入口：它自己不含版本号，所以每次都要现读指针，
路径永远指向当前那一份 immutable 包。

### Range

下载器续传只支持**单区间**：`bytes=a-b`、`bytes=a-`、`bytes=-n`。

- 结束值越界 → 夹到文件尾（RFC 9110 允许）。
- 起点越出文件尾 → `416` + `Content-Range: bytes */<size>`，让下载器重新取整份。
- 多区间、`items=`、怪异语法 → 忽略 Range 回整份：猜一个区间比给全份更容易出错。

### 缓存口径

- immutable 包：`max-age=31536000, immutable`。同一个 URL 永远是同一串字节，缓存越久越好。
- manifest 与 latest：`no-store`。缓存住指针，手机就永远看不到新版本。
- 404 / 405 / 416 / 503：`no-store`。

## 四、manifest 字段

```json
{
  "schemaVersion": 1,
  "packageName": "com.dsh.botcrew",
  "versionCode": 7,
  "versionName": "0.7.0",
  "buildId": "b7",
  "minSdk": 26,
  "sha256": "<64 位小写 hex>",
  "size": 4096,
  "signerSha256": "<64 位小写 hex>",
  "apkPath": "/updates/android/7/<sha256>.apk",
  "notes": "可选"
}
```

校验规则（不满足 → `503`，不把坏数据发给手机）：

- `schemaVersion` 恰为 `1`；`packageName` 恰为 `com.dsh.botcrew`。
- `versionCode` 为 **1…2100000000** 的整数（发布 CLI 能发的完整区间，也是 URL 上接受的那一段）；
  `size > 0`；`minSdk` 为 ≥21 的整数。
- `versionName` / `buildId` 非空且 ≤256 字符。
- `sha256` / `signerSha256` 为 64 位小写十六进制。
- **`apkPath` 必须严格等于 `/updates/android/<versionCode>/<sha256>.apk`**（由上面两个字段推出）。

`notes` 只是展示用：写坏了就丢掉它，不因此让整次发布失效 —— 那等于谁都升不了级。

发出去的 JSON 是**重新拼过的**：认得的字段按固定顺序重拼，未知字段不进输出。
manifest 是外部写进来的文件，原样转发等于让写它的人顺手决定发给手机的每一个字节
（多塞一个看着像本机路径的字段，读的人就会当它可信）。`apkPath` 尤其不能照抄：
它必须是推导出来的那一个，否则这个指针就能把用户带去读任意文件。

## 五、拒绝与不泄露

- **不 decode 路径**。合法的三种形状里没有需要解码的字符，而解码只会让 `%2e%2e%2f` 变成另一个名字。
  带编码的穿越请求一律 `404`。
- `versionCode` 必须是 1…2100000000 的规范十进制：拒前导零（`007` ≠ `7`，不该是两个地址）、
  拒 0 / 负数、拒 11 位、拒空段。路由与 manifest 用**同一段**区间，否则 manifest 认的版本号
  在 URL 上取不到。
- 文件名必须恰好是 64 位小写 hex + `.apk`；`.apk.exe`、无扩展名、多一层子目录都不认。
- **先 realpath 对齐分发根，再 stat**，APK 与 `manifest.json` **两处都做**：发布目录里被塞进来的
  符号链接不能把这条公开进口带到目录之外（`tests/updates.spec.ts` 各用一个指向根外的链接钉住）。
  `manifest.json` 那处尤其要紧 —— 它是这条路要读的第一个文件，指向根外等于读本机任意一份 JSON。
- 指针必须真的指到一个能下的包：**APK 缺失或实际大小与 `size` 不符 → `503`**，不发一条下不动的指针
  （发布 CLI 先写 APK 再改 manifest，对不上就只有一个解释：发布坏了）。APK 本身仍按原 URL 可取。
- 文件存在且 `isFile` 且 `size > 0` **之后**才发 header；缺失、断链、读不了一律 `404`，不区分原因
  （那是在帮人探目录）。
- 回应里不出现本机路径、不出现内部错误文本。头已发出之后的失败只能切断连接，不能回一段错误体。
- 大文件不进内存：`createReadStream` + `pipeline` 直通 `ServerResponse`。
  断连（换网、锁屏、取消）走 `.catch()` 收掉，不产生未捕获异常，也不影响下一条请求。

## 六、为什么不验凭据、为什么不泄露东西

升级这条路本身有个死锁：手机上的旧版本要装新的，就得先下到包；而包能不能下不该取决于
那个旧版本还记不记得自己的配对凭据（重装、换机、清数据都会丢）。所以这**一片**公开。

公开得安全，靠的是两件**外面**的保证，不是这一层的判断：

1. 发出去的 APK 不含任何凭据 —— 由发布 CLI 保证（包内只有 App 自己的代码与资源）。
2. 发布目录里只有包与指针 —— 这一层再用固定路径形状 + realpath 对齐把「只有」钉成机制。

App 那一侧仍然做 sha256 / 包名 / versionCode / 签名指纹的最终校验，所以即使这里被换了包也装不上。
这一层不替它做那个判断。

## 七、测试证据

`backend/tests/updates.spec.ts`（真实 Node HTTP + 真回环 fetch，无新依赖）：

| 用例 | 钉住的东西 |
|---|---|
| public upgrade surface | 不带凭据能取 manifest，同一监听上 `/api/mobile/timeline` 仍 `401`（含带错凭据） |
| manifest 原样 | `no-store`、`application/json`、HEAD 只回头 |
| 一个 APK 三种取法 | GET 全份字节相等、HEAD 只回头、`bytes=100-199` → `206` + `Content-Range`、`bytes=4000-` 尾巴、越界 `416` |
| 发版之后 | latest 指针跟着 manifest 走；旧 immutable 按原 URL 仍可取、仍支持 Range |
| 目录跳转 | `/updates/android/` 与裸前缀都 `302` 到 latest |
| refusals | 未发布 `404`；错 code、错 sha `404` |
| 穿越与编码 | 12 个敌意路径全 `404`，回应里不含本机目录名；`%2e%2e%2f` 用原始字节发请求（fetch 会自己规范化，那样测的就不是服务端） |
| 方法 | `POST/PUT/DELETE/PATCH/OPTIONS` → `405` + `Allow` |
| 符号链接逃逸 | 指向 `state.db` 的链接 `404` |
| 坏 manifest | 敌意 `apkPath`、坏 JSON、错包名、非法 sha 全 `503`，不回显路径 |
| 下载中途断开 | 请求销毁后服务端仍正常，下一条请求整份字节相等 |
| Range 解析 | 单区间/开放尾/尾段/越界/多区间/怪异语法逐条 |
| 字段校验 | 接受契约；16 种错字段逐条拒绝；未知字段不进输出；超长 notes 丢弃但发布仍有效 |
| versionCode 边界 | 1 与 2100000000（10 位）真实 GET/HEAD/Range/latest 全通；越上界、0、负数、前导零、11 位全 404；manifest 越界 503 |
| 指针本身 | manifest 软链出根 → 503（包仍可取）；APK 缺失 / size 不符 → 503 |
| 没有分发根 | 老行为不变：`/updates/android/*` `404`，消息面照旧 |
| 多个绑定位 | 每个监听上都发同一片区域 |

`backend/tests/lan-server.spec.ts` 加一条跨面回归：公开区域存在时消息面仍 `401`，
且公开的那几只地址不会进 `forward`（`seen` 为空）。

实跑：`tsc --noEmit` 通过；`vitest run tests/updates.spec.ts tests/lan-server.spec.ts`
→ 2 文件 42 例全过；`tests/index.spec.ts`、`index-forward-headers`、`headless-http`、`deployment`
共 33 例全过（收敛后复跑 index / forward-headers / headless-http 28 例仍全过）。

## 八、留给 root 收口的两处

1. `backend/docs/007-architecture.md` 的 `## Modules` 与 `## Tests` 表要各加一行
   （`src/app/updates.ts`、`tests/updates.spec.ts`）—— 该文件不在本任务的写入范围，
   `tests/docs.spec.ts` 会因为缺这两行报红。
2. 生产加载的是 `lib/`，改完 `backend/src/**` 需要 `./node_modules/.bin/tsdown`；本任务未构建、未部署。
