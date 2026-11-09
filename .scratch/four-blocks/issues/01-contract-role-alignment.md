# 01 · 契约与网关的 role 值对齐

**阻塞**：无 — 这是第一张票，其余全排在它后面。

## 要做什么

`backend/src/contract/types.ts:45` 的 `TimelineItem.role` 声明是 `'bot' | 'user' | 'system'`，
但网关 `backend/tools/mobilegw:98,101` 实际发出的是 `'user' | 'agent'`。实测：

```
GET http://127.0.0.1:8788/timeline?conversation=main
→ role 值集合 = {'agent', 'user'}
```

任何按契约实现的客户端都会在运行时丢消息。先让两边对齐。

## 决策

**改契约，不改网关。** 理由：网关是线上已经在跑的协议，手机端和现有测试都按它实现；契约文档是后来写的，写错了。改一个类型比改一个线上协议便宜。

新契约：`role: 'user' | 'agent'`。

`bot_id` 字段已经能区分是哪个 Bot 说的，`kind` 区分 acknowledgement / reply / notice，不需要再来一个 `'system'`——网关从来不发它。

## 验收

1. `contract/types.ts` 的 `role` 联合类型是 `'user' | 'agent'`，注释说明每个值的含义。
2. 有一个测试，从契约取值出发，验证它能覆盖网关的两种输出（不依赖网关进程，直接对字面量断言即可）。
3. `backend/` 全量测试仍然全绿。

## 边界

只改类型与注释，不改网关行为，不动 `mobile-http.ts` 的转发逻辑。
