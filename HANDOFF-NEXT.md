# 交接：手机通道升级到 tailcat（P2P 主用 + 中转兜底）

写于 2026-11-12 12:50。上一个交接（四期补齐 + DSH Desktop 排障）的内容已完成，本文件只记当前状态。

## 一、这一轮做了什么

原来手机只有两条路：同一 Wi-Fi 下的 LAN 直连、Cloudflare 隧道兜底。现在按「P2P 主用 → LAN → 中转兜底」三条路走，P2P 用 Tailscale 官方的 data plane。

**为什么是 tailcat 而不是自己写打洞**：dsh-mobile 那个 `dsh-tailcat-host` 二进制里装的就是 `github.com/tailscale/tailcat` + `tailscale.com`（strings 能看到 magicsock/gvisor/netstack/wireguard/DERP）。tailcat 是 Tailscale 官方的 "Tailscale without Tailscale"：magicsock 打洞、WireGuard 加密、gVisor netstack、DERP 兜底，**不需要 Tailscale 账号、不需要 root、不改路由表**。手机端因此不用装任何 VPN 客户端。

## 二、当前状态

| 项 | 值 |
|---|---|
| 仓库 / 分支 | `/Users/cpuser/Code/dsh-bot-crew` @ `feat/four-blocks` |
| 后端测试 | 98 文件 / **1667** 全过 |
| App 单测 | **199+** 全过（含 CrewRoute 9、CrewClientRoute 6、PairingRecord 5、CrewNearby 16） |
| crew 后端 | 在跑（superagent profile），health 全 ready 含 `p2p: ready` |
| mobilegw | launchd `com.cpuser.dsh-mobilegw` 托管，8788 |
| CF 中转 | launchd `com.cpuser.crew-mobile-tunnel` 托管，`crew.kentonnie.top → 127.0.0.1:43499` |
| 未跟踪 | `HANDOFF-NEXT.md`、`scripts/crew-watch/`（别人的，别动） |

## 三、三条路各自是什么

```
手机 App ──① P2P(tailcat)──┐
         ──② LAN 直连 ─────┼──► 127.0.0.1:43499 / 192.168.113.134:43499 (lan-server)
         ──③ 中转(CF)──────┘
```

| 路 | 机制 | 实测 |
|---|---|---|
| ① P2P | `tailcat serve --key=default 43499` + 手机端 libtailcat.so | 同网段 **16ms**；跨两个 Wi-Fi **13ms**（都打洞成功，界面按实测值显示） |
| ② LAN | mDNS 发现 + 直连 | **3–6ms** |
| ③ 中转 | cloudflared → 43499 | **130–165ms** |

**关键实测结论**：跨 `7x_Acc_5G`(192.168.113.x) 与 `cp-net-6F`(192.168.111.x) 时 magicsock **打洞成功**，App 那条连接稳态一个来回 13ms；同网段 16ms。两种网络界面都显示「P2P 直连」，是对的。

**一个容易测错的地方**：`tailcat ping <addr>` 从电脑侧新起了一个 client 实例，它的首连会先落 DERP（`pong via DERP(tok)` 133–146ms），之后才升级直连。这与 App 那条已建立的连接不是一回事 —— 判断路径必须看 App 自己的探测日志（`CrewP2p: 隧道首连 …ms，稳态一个来回 …ms`），别拿 CLI ping 当证据。

**界面的诚实性规则**：隧道通 ≠ 直连。`TailcatP2p.probe` 先带凭据请求 `timeline` 只判通、不计时（首连含注册 + DERP 引导，1.5–1.8s），再在同一条 keep-alive 连接上打两次 `GET /api/mobile/__latency`（必然 404、服务端几乎不做事）取最小值作稳态往返；`< 40ms` 显示「P2P 直连」，否则「隧道中继（Xms）」。阈值依据：直连 13–16ms、经 DERP 130–146ms。**不要用 `tc_client_ping` 当判据** —— 头文件写明它量的是 the DERP path；`tc_info` 对 client 只回 `public_key`，没有 direct/derp 字段。

## 四、代码落点

**后端（全部在 `backend/`）**
- `src/app/p2p.ts`：起 `tools/tailcat serve --key=default <port>` 子进程；tc-addr 从 **stderr** 解析（正则是形状匹配 `/\b(tcp[A-Za-z0-9_-]{40,})/`，因为两种文案：`with new address:` 与 `with saved key "default":`）；崩溃指数退避（1/2/5/10/30s 封顶，**活过 60s 才归零**，否则崩溃循环会一直 1s 重拉 30MB 二进制）；进程退出立即清地址
- `src/app/public-entry.ts`：公网入口，`CREW_PUBLIC_URL` 优先，其次 `<stateDir>/mobile-public-url`；裸主机补 https、去尾斜杠
- `src/app/discovery.ts`：mDNS TXT 现在四格 `{crew, port, pub, p2p}`；`p2p` 是**取值器**（地址后到、会变）
- `src/index.ts`：接线 + 健康项 `p2p` + 地址落盘 `<stateDir>/mobile-p2p-addr`；监听一个地址都没绑上时把 `p2p` 健康项标红
- 地址落盘的意义：后端重启后、tailcat 还没喷新地址的那几秒，手机仍拿得到上次那个（地址由密钥决定，所以旧地址仍有效）
- `runtime.claimHealth(name, initial)`：新加的公开入口，给 runtime 之外的组件登记健康项
- `pairing-throttle.ts`：回环写法（127/8、::1、::ffff:127.x）折进同一个 `loopback` 桶 —— 原来两条回环能拿到双份额度，方向是变松

**Android（全部在 `app/`）**
- `jniLibs/arm64-v8a/libtailcat.so`（16.6MB，**不入库**，用 `backend/scripts/build-tailcat-android` 重建）
- `cpp/tailcat_jni.c` + `cpp/tailcat_abi.h` + `cpp/CMakeLists.txt`：JNI 薄封装，`dlopen` 找符号（不链接期依赖）
- `TailcatNative.kt` / `TailcatP2p.kt`：回环 ServerSocket 代理，每条连接 `dial(43499, TCP)` 后双向 pipe
- `CrewRoute.kt`：纯选路逻辑（可测）
- `CrewClient.kt`：`entries` 优先级表 + `promote(entry)`（运行期把 P2P 提到队首，`@Volatile` 整表替换，请求开头抓快照）
- `MainActivity.kt`：启动先走 LAN/公网不等待，P2P 在后台探 15s，通了 promote

**phone 端 JNI 的关键坑（已修）**：`GOOS=android` 的 cgo 库里 `net.Interfaces()` 必然失败（App uid 无 NETLINK_ROUTE），`netmon.New` 直接报 `netlinkrib: permission denied`。`feature/androidbin` 的构建约束是 `(linux && !android) || (android && !cgo)`，cgo 的 Android 库要调用方自己注册 —— 已在 `build-tailcat-android` 里注入一个 `//go:build android` 的文件注册 `netmon.HookInterfacesFallback`（照 androidbin 思路：dial UDP 拿出站源地址合成假接口）。

## 五、构建与运行

```bash
# 电脑端 tailcat 助手（约 30MB，不入库）
backend/scripts/build-tailcat            # 编到 backend/tools/tailcat

# Android 原生库（约 16.6MB，不入库）
backend/scripts/build-tailcat-android    # 编到 app/app/src/main/jniLibs/arm64-v8a/

# crew 后端
cd backend && ./scripts/dsh-superagent status|start|restart   # 默认 profile superagent
```

**改了 `backend/src/**` 之后必须 `./node_modules/.bin/tsdown`** —— 插件加载的是 `lib/`，不是 `src/`。踩过一次，改完没构建，行为完全没变。

## 六、待办

- [x] 界面文案按实测延迟区分「P2P 直连 / 隧道中继（Xms）」（`CrewRoute.tunnelLabel`，40ms 为界，单测覆盖 1/12/39/40/137/146/null）
- [x] 跨网段真机复验：手机在 `cp-net-6F`、Mac 在 `192.168.113.134`，App 探针稳态 **11ms** → 界面「P2P 直连」，与 LAN 基线同量级、比 DERP 的 130ms+ 低一个数量级，有实测支撑
- [x] 代码入库并推送：`890dd2e`（20 改 + 15 新，`.so` 已忽略、`scripts/crew-watch/` 属他人未动）；后端 1667 例、App 201 例全过
- [x] 宿主侧推送链路接上并入库：`c0a6599`（`Tunnel.push` + `runtime.attachPusher` + `index.ts` 接线，用真中转端到端验过）
- [x] 设备号校验 bug 修掉并入库：`5b2556d` —— 见下面 §九，这条曾让推送 100% 静默失败
- [ ] 家里路由器上重测打洞（那台若支持 UPnP，portmapper 已编译进来，可能真能直连）
- [ ] **App 侧推送接收（从零开始，见 §九）**：`pushRegister` 上报、长连接收 `pushSend`、通知权限与展示
- [ ] 播报、审批三档、语音、hourly 账、记忆 settle/recall 的真机验（交接旧文 §五 那批）
- [ ] `--allow` 客户端白名单：目前靠 `--psk`（默认开）+ 应用层设备凭据；要收紧得让手机先上报 node key
- [ ] jniLibs 的 `.so` 换版本后建议 `clean` 一次再打 APK（AGP 增量打包会留死字节，实测能多出 16.6MB）

## 七、红线（照旧，仍然有效）

1. **绝不 `pkill -f dsh`** —— 会连 Desktop 一起杀掉。
2. 不要动 launchd `com.cpuser.dsh-mobilegw`（8788）与 `com.cpuser.crew-mobile-tunnel`（CF 中转）。
3. crew 只在 `superagent` profile 跑。
4. 提交后立刻 `git push origin feat/four-blocks`。
5. 改 `desktop`/`web` profile 前先确认没有宿主在跑，并且先备份。
6. 跑 `pnpm add/remove` 前先看 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 有没有被插件市场写坏。

## 八、环境事实（新增/变化）

- Go 1.25.3 本机；tailcat 的 `go.mod` 要 1.27.2，靠 `GOTOOLCHAIN` 自动下载
- Android NDK `28.2.13676358`；minSdk 26
- K80（`PEDM00`，arm64-v8a，Android 14）：`svc power stayon true` + 锁屏禁不掉（`locksettings set-disabled true` 返回成功但 `get-disabled` 仍是 false，ColorOS 不认），**所以别让它息屏**；一旦息屏就要人工指纹解锁
- 测试机网络：`7x_Acc_5G`（192.168.113.x，Mac 所在）与 `cp-net-6F`（192.168.111.x）是两个不同网段，可用来做跨网段验证
- `~/.dsh/state/superagent/mobile-p2p-addr` 存当前 tc-addr；`mobile-public-url` 存公网入口

## 九、推送链路的真实拓扑（2026-11-12 13:10 查清）

这一段是给下一个接手的人的，因为「推送待办」过去几轮一直被当成「验一下」，实际是三条链里只通了一条。

```
宿主 pushNotice
  └─① Tunnel.push → T.pushSend → wss://jarvis.kentonnie.top/crew-relay/tunnel
        └─ 中转：device 在线就直送、离线留件（push delivered / push queued / push flushed）
              └─② 手机长连接收 T.pushSend      ← 这一环不存在
                    └─③ 系统通知展示            ← 这一环不存在
```

**① 宿主 → 中转：已通，真机验过**
`Tunnel.push()` 只在 `state==='live'` 时发（连接建起来但没注册成功的那一段，中转不认这条隧道）；空正文也挡在宿主侧。真实验证：临时隧道 `kenton-mac-pushtest` 连上真中转，`push=true`，帧确实发出。中转 `/crew-relay/health` 返回 `tunnels:1`（就是宿主那条 `kenton-mac`）。

**②③ 手机侧：一行代码都没有**
- App 是**纯 HTTP**（`HttpURLConnection`），没有 WebSocket，所以发不出 `pushRegister`
- 没有任何地方处理 `T.pushSend`
- `AndroidManifest.xml` 里**没有通知权限、没有 Service、没有 FCM**

所以待办「推送真机验」的真实工作量是**新建两条链**，不是验收。要做的最小版本：App 起一条到中转的 WS（或复用 P2P 隧道）→ 发 `pushRegister{deviceId, platform, token}` → 收 `pushSend` → 用 `NotificationManager` 弹出（Android 13+ 要 `POST_NOTIFICATIONS` 运行时权限）。系统推送（FCM/APNs）是第三档，要账号与凭据，`push.ts` 已按 `no_provider` 如实处理，可以不做。

**踩过的坑：设备号正则曾让推送 100% 静默失败**
`push.ts` 的 `DEVICE_ID` 原为 `/^dev_[a-z0-9]{6,40}$/`，注释还写「与设备表一致」；但设备表里三条真实记录是 `crew-desktop`、`d021988751fdd554`、`66e74d226c1e38fa`，**一个都不带 `dev_` 前缀**（手机报的是 `ANDROID_ID`）。中转侧 `pushRegister`/`pushSend` 两处同样的内联正则也直接 `return`。后果是每一帧都被丢、日志里连 `push delivered/queued` 都不出现 —— 最难查的那种。已在 `5b2556d` 修正为 `/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/`（只挡空、带空白、过长），测试样例也从假的 `dev_abc123` 换成真实形状。

**中转地址与密钥**
- 地址：`wss://jarvis.kentonnie.top/crew-relay/tunnel`；健康检查 `/crew-relay/health` 返回 `{ok,uptimeMs,tunnels}`
- 配置在仓库外：`~/.config/crew-desktop/relay.env`（600），`dsh-superagent` 启动时 `set -a; . relay.env` 载入
- 变量：`CREW_RELAY_URLS` / `CREW_RELAY_INSTANCE`（`kenton-mac`）/ `CREW_RELAY_SECRET` / `CREW_RELAY_ADMIN_TOKEN`
- **不要**把密钥写进仓库或日志

**手工验证脚本**（要外网，不进常规套件）
```bash
cd backend && ./node_modules/.bin/vitest run tests/manual/live-push.spec.ts
```
