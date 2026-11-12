# 语音二进制载体：LAN 与公网链路修复

2026-11-12。桌面「语音输入」与「听播报」真实窗口联调暴露了两个单测没覆盖的载体缺陷，已定位并修复，全程后台源码/测试，无 GUI 操作、无运行态变更、无部署。

## 缺陷与修复

### 1. LAN 载体把音频当文本、且音量上限太小（`backend/src/app/lan-server.ts`）

- 原实现 `readBody` 一律 `Buffer.concat(...).toString('utf8')`：非 UTF-8 的 WAV 采样字节被替换字符污染（364 字节样例变成更长的坏字节）。
- 原实现 `MAX_BODY_BYTES = 256KiB`：120 秒 16k 单声道 PCM（约 3.84MB）直接 413。
- 修复：`readBody` 返回原始 `Buffer`（`Uint8Array<ArrayBuffer>`），`forward` 的 `body` 类型改为字节；`/api/mobile/voice` 上限用 `voice.ts` 的 `MAX_WAV_BYTES`（8MiB），其余路径仍 256KiB。转发回来的 `x-speech-seconds` / `x-speech-truncated` 一并透传。

### 2. 公网 relay→tunnel 载体（`relay/src/{server,main}.ts`、`backend/src/{app/tunnel,index}.ts`）

- tunnel 把 `Buffer.concat(chunks).toString('utf8')` 当正文：同样污染非 UTF-8 音频。新增 `rawBody: Uint8Array<ArrayBuffer>`，`index.ts` 用 `rawBody ?? body`，空 Buffer 不再当 body（GET 兼容）。
- relay 默认 `maxRequestBodyBytes = 256KiB` 挡掉正常录音。`optionsFromEnv` 不再无条件填默认值，未显式设置时对 `audio/wav` 用 `maxMediaBodyBytes`（默认 8MiB）；管理员显式 `RELAY_MAX_BODY_BYTES` / `maxRequestBodyBytes` 仍对包括 WAV 在内的全部请求优先。
- 宿主把 Response 按 `reader.read()` 的返回值发帧，一次读取可能远超单帧上限（大响应会被合并）。现按 64KiB 切帧发送（`tunnel.ts` 的 `CHUNK_BYTES`），避免中转解码器把大帧判成协议错误而关闭整条隧道。
- 中转 `maxFrameBytes` 抬到 `maxMediaBodyBytes + 64KiB`，容纳合法大响应；宿主响应缓冲上限也抬到 `媒体上限 + 4MiB`，避免内核没写出去时被误判成慢流。

## 自动验证

`backend/tests/voice-carrier.spec.ts`（新建，真实 HTTP → 真中转 → 真隧道回环，无麦克风/识别器）：

- 0.01 秒与 120 秒 WAV（含 0xff 非 UTF-8 采样）经真实链路逐字节完整，SHA-256 与原文一致。
- 普通 JSON 串与空 GET 仍兼容（GET 不带 body）。
- 普通 JSON 超过 256KiB 在语音 URL 上仍 413。
- 显式管理员上限对 WAV 生效并 413。
- 超过 8MiB 的 WAV 在转发前 413。

`backend/tests/lan-server.spec.ts` 新增两条：64 字节与 300000 字节原始语音字节经 LAN 完整往返，含 `x-speech-*` 头。

回归：`voice-carrier.spec.ts` 7/7、`tunnel.spec.ts` 与 `lan-server.spec.ts` 合计 25/25 通过；`backend` 与 `relay` 的 `tsc --noEmit` 均退出 0。

## 待真实环境与范围外

- 这些是载体层修复；**后端语音识别器本身仍未接入**（`voice.ts` 需要可用识别插件/提供方），真实设备上点「停止并识别」当前会如实显示「这台后端没有可用的语音识别」，这是已知未接入，不是本次回归。
- relay 只有在部署后才会加载新代码；本轮未部署、未重启服务。
- 真实手机经公网/局域网发起语音上传与播放仍待联调。
