# 03 · 接进宿主

本仓库不 fork 宿主，只把三个文件放进去 + 一处注册 + 一处提示词小节。

## 1. 复制文件

```sh
HOST=./backend
cp src/crew/directory.ts  "$HOST/src/crew/directory.ts"
cp src/crew/route.ts      "$HOST/src/crew/route.ts"
cp src/sources/team.ts    "$HOST/src/sources/team.ts"
```

`src/crew/` 是新目录；`src/sources/team.ts` 与宿主的 `mobile.ts` 同构，读同一个 `mobileq` 队列。

## 2. 注册 Source

`cordis.patch.yml` 的 `insert` 里，跟在 `dsh-superagent-mobile` 后面：

```yaml
    - id: dsh-superagent-team
      name: dsh-superagent/team
      disabled: true
```

**默认 `disabled`**：名单为空时它会把消息收进来却无处路由，所以先注册、配好名单再打开。

## 3. worker 的 Bot 身份

宿主 `src/app/prompts.ts` 加一个 `crewSection()`，并在 `Prompts.compose` 里传进去：

- 只在 `DSH_SUPERAGENT_CREW_BOT` 非空（即工单来自 team 来源）时出现；
- 内容：`## Bot you are` + 这个 Bot 的名字、人格、记忆命名空间；
- 明确写「这是呈现不是授权，mandate 与 ticket 才决定你能做什么」。

环境变量本身由 team Source 的 `environment` 声明，宿主的 `runtime/environment` 小节会自动列出来，不需要额外改。

## 4. 宿主自带的三个文档一致性测试

改宿主会踩到这两条测试，必须同步补文档，否则 `pnpm test` 红：

| 测试 | 要补什么 |
| --- | --- |
| `tests/bundle-patch.spec.ts` | 期望的 `id` 数组里加上 `dsh-superagent-team` |
| `tests/docs.spec.ts` 模块表 | `docs/007-architecture.md` 的 `## Modules` 表加 `src/crew/directory.ts`、`src/crew/route.ts`、`src/sources/team.ts` |
| `tests/docs.spec.ts` 测试表 | `## Tests` 表加新增的两个测试文件 |

另外：**备份文件不要留在 `src/` 或 `tools/` 下**，`docs.spec.ts` 会把它们当成模块报错。放到 `.artifacts/backups/`。

## 5. 队列

`tools/mobileq` 需要 `mentions` 列与 `--mention` 参数：

```sh
mobileq inject --conversation ops --sender u-1 --text "写手写段文案" --mention scribbler
mobileq inject --conversation ops --sender u-1 --text "群里随便说一句"        # 大哥接
```

旧用法（`--mentions-me`）保持可用，`mentions_me` 字段照旧输出，`mobile` Source 不受影响。

## 6. 验证

```sh
pnpm typecheck && pnpm test && pnpm build
```

已验证：`tsc --noEmit` 0 错、1213 个测试全绿、`tsdown` 构建通过。
