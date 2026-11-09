# 08 · 根 README 与四块入口对齐

**阻塞**：02。

## 要做什么

根 README 现在还在描述「轻量契约层 + 宿主在别处」的旧结构。改成四块，每块一句话说清它是什么、怎么构建、怎么跑。

## 验收

1. README 的结构图与实际目录一致。
2. 每一块都有「从这里开始」的一条命令。
3. 没有指向 `~/Code/dsh-superagent` 或 `~/Code/dsh-mobile-app` 的活引用。
4. `docs/05-running.md` 与 `dsh-bridge/README.md` 不互相矛盾。

## 边界

不改 `backend/docs/` 里的上游文档。
