# Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles map to `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root plus `docs/adr/`. See `docs/agents/domain.md`.

### 开发期原则：有问题就根治，不留小修小补

本项目**处于开发期**，不存在「先糊过去、以后再补」的小修小补。

- **遇到 bug 先找根因，再改根因。** 现象层打补丁（加个 try/catch、塞个默认值、重启一下就好）一律不接受，除非能证明根因暂时在外仓/无法触及——那也要在代码或 ADR 里写清「为什么是根因、为什么现在碰不到、补丁何时该被删掉」。
- **修一个 bug 时顺带把同类隐患一起收口。** 例如一个字段用默认值掩盖了异常，就检查所有同类字段；一个 provider 下线导致静默卡死，就让「不可用」在启动期就暴露（配合看门狗告警），而不是让用户等超时。
- **「重启又回到旧状态」是典型信号**：说明状态持久化/初始化逻辑有洞，必须修初始化逻辑本身，而不是每次手动再改一遍。
- **不接受**：静默降级、静默吞错、把「约定俗成」当保障（约定要变成机制，见 #9 隔离的思路）。
- 改完要有**测试证据**（单测/集成），并在 commit 里写清「修的是哪个根因、为什么这样修是根治而非打补丁」。
