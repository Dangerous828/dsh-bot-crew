# 04 · desktop 消息面客户端：拉时间线、发消息

**阻塞**：01、03。

## 要做什么

`desktop/` 里写一个纯 Go 的客户端包（不含 UI），只做两件事：拉时间线、发消息。接的是消息面（ADR-0002）。

```
GET  /api/mobile/timeline          → items[], bots[], default_bot_id, tasks[], status
POST /api/mobile/send              ← {text, request_id, mentions?}
```

## 要点

1. **按 01 对齐后的契约解析**：`role` 只有 `'user' | 'agent'`，未知字段保留不丢。
2. **`request_id` 是幂等键**：重试必须沿用同一个值。客户端要能生成一次、重试复用。
3. **不传 `sender`**：身份由服务端的 owner 认定，客户端不自己声明。
4. **错误可读**：401 说清是 token 问题，502 说清是 gateway 没起来，不说「请求失败」。

## 验收

1. 有一个 Go 测试，喂一份真实的 timeline JSON（从网关抓的样本，脱敏后放进 `testdata/`），验证解析出正确的消息条数、角色分布、Bot 名录。
2. 有一个 Go 测试，验证 `request_id` 在重试路径上被复用而不是重新生成。
3. 对真后端跑一次：发出「你好」→ 收到 Bot 回复。证据留在票里。

## 边界

不做 UI。不做缓存。不做重连。
