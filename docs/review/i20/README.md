# #20 弱网 / 跨 NAT 打洞专项：可复现台架

本目录只放**验证脚本与实测产物**，不含产品源码改动。

## 结论先行

| 项 | 能不能在现有条件下验 | 实测数字 |
|---|---|---|
| 第 2 项 `probeBudget()` 真实超时行为 | **能，已验完** | 预算对「对端完全静默」有效（封在 20.17s）；对「对端慢滴」**失效**（21 / 41 / 82 秒，无上界） |
| 第 1 项 弱网 / 跨 NAT 打洞成功率 | **不能验**：本机拿不到跨 NAT 条件 | 真实跨主机隧道 120/120，但那是**同一 NAT 内直连**，不是打洞 |

## 文件

| 文件 | 作用 |
|---|---|
| `probe_server.py` | 可控的「隧道那头」：`normal` / `hang` / `delay` / `drip` 四种劣化。**只劣化 TCP 代理层**，不模拟 UDP 打洞 |
| `ProbeHarness.kt` | 直接调用产品 `TailcatP2p.probe()`，不复制不改写 |
| `run_probe_matrix.py` | 超时矩阵（A–H） |
| `run_probe_overrun.py` | 慢滴越过预算的量化 |
| `failpath.py` | 真实隧道上的失败路径与自愈（三阶段） |
| `matrix.json` / `overrun.json` | 上两者的原始产物 |
| `soak-120.txt` / `path-30.txt` | 真实跨主机隧道的 120 轮探针与 30 次新连接路径分布 |

## 复现

```bash
# 1) 编译真机源码（android.util.Log / org.json 用最小替身）
cd /tmp/i20 && /tmp/kotlinc-copy/bin/kotlinc -nowarn -d out \
  TailcatP2p.kt CrewRoute.kt TailcatNative.kt CrewPairing.kt stubs/*.kt
/tmp/kotlinc-copy/bin/kotlinc -nowarn -cp out -d harness ProbeHarness.kt

# 2) 超时矩阵
cd docs/review/i20 && python3 run_probe_matrix.py > matrix.json 2> matrix.log
python3 run_probe_overrun.py > overrun.json 2> overrun.log
```

`run_probe_matrix.py` 里 `CLASSES` 需按本机路径改：产品 classes + harness + `kotlin-stdlib.jar`。

## 一条必须记住的台架陷阱

`probe()` 用 `stream.readBytes()` 读正文 —— 它读到 **EOF** 才返回，不是读到 `Content-Length`。
所以台架每个响应都必须带 `Connection: close` 并在发完 body 后立刻关连接。第一版台架用了
keep-alive，凭空造出 5 秒延迟，把 A/B 两例全污染成假超时。看到反常数字先怀疑台架。
