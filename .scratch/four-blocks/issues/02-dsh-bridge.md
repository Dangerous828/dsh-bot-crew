# 02 · dsh-bridge 目录成形

**阻塞**：01（弱依赖，只为了让票按顺序落地）— 实际可并行。

## 要做什么

`dsh-bridge/` 现在是个空目录。按 ADR-0001，它不是插件工程，只承担装配职责。

## 内容

1. **profile 补丁**：把 `backend/cordis.patch.yml` 需要的宿主侧配置（`stateDir`、`webserver` 端口）整理成一份可直接拷进 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的样例，路径里的占位符写清楚。
2. **preset 说明**：`dsh-superagent-worker` 与 `dsh-superagent-router` 的定义仍在 backend 的 bundle patch 里（它们是插件的一部分，不能搬走）。这一块只写一份文档，说明它们为什么在那儿、什么时候会被用到。
3. **启动脚本**：一条命令把 dsh 起起来、把 gateway 起起来、报告端口与 token 在哪。

## 验收

1. `dsh-bridge/README.md` 说清楚：这块放什么、不放什么、为什么不做成插件。
2. 有 `dsh-bridge/profile.example.yml`，字段与 backend 实际读取的一致。
3. 有 `dsh-bridge/up.sh`，双击/命令行都能用；失败时有可读的报错，不静默。
4. 根 README 里四块的表格与它一致。

## 边界

不写一行 TypeScript。不做进程管理（那是 backend 自己的 `scripts/dsh-superagent`）。
