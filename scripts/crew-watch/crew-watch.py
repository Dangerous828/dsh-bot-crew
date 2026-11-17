#!/usr/bin/env python3
"""crew-watch.py — dsh-superagent / bot-crew 只读监工探针。

用法:
    python3 crew-watch.py [--port 3082]

输出: 一行行的人类可读告警 + 末尾 JSON；退出码 0=健康 1=有告警 2=取不到数据。
只读: 只发 GET，不改设置、不派活、不停机、不写任何 crew 状态。
给 dsh-bot 当监工时，本脚本是「本地兜底数据面」；主数据面直接用 crew 的
/orchestrator/api/* GET（见 监工接线.md）。
"""
import argparse
import json
import sys
import urllib.request
from datetime import datetime

READY = ("ready", "paused")


def get(port: int, path: str):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/orchestrator/api/{path}",
        headers={"Host": f"127.0.0.1:{port}", "x-orchestrator-request": "1"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        return json.load(resp)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3082)
    args = ap.parse_args()

    result = {
        "at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "port": args.port,
        "alerts": [],
    }
    try:
        state = get(args.port, "state")
        tickets = get(args.port, "tickets")
        settings = get(args.port, "settings")
        sources = get(args.port, "sources")
    except Exception as exc:  # 网络/解析/围栏拒绝都算取数失败
        result["alerts"].append(f"取数失败: {exc}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2

    health = state.get("health") or {}
    bad = {
        k: {"state": v.get("state"), "detail": v.get("detail")}
        for k, v in health.items()
        if isinstance(v, dict) and v.get("state") not in READY
    }
    result["health_bad"] = bad
    if bad:
        result["alerts"].append(
            "部件异常: " + ", ".join(f"{k}={v['state']}" for k, v in bad.items())
        )
    if (health.get("evals") or {}).get("state") == "error":
        result["alerts"].append(
            "evals=error: 过去一小时有 Eval 不可用且未被判定/忽略，可能出现「消息进来了但永不开工单」"
        )

    load = state.get("load") or {}
    total = tickets.get("total") or 0
    result["load"] = load
    result["tickets_total"] = total
    result["paused"] = state.get("paused")
    if total > 0 and (load.get("running") or 0) == 0 and not state.get("paused"):
        result["alerts"].append(
            f"有 {total} 张工单但没有运行中的 worker（running=0），检查是否卡在 queued"
        )
    if (load.get("queued") or 0) > (load.get("maxWorkers") or 3) * 2:
        result["alerts"].append(f"排队积压: queued={load['queued']}")

    blocks = settings.get("blocks") or {}
    models = {
        name: (blocks.get(name) or {}).get("value", {}).get("model")
        for name in ("eval", "executor")
    }
    result["models"] = models
    if any(v is None for v in models.values()):
        result["alerts"].append(
            "eval/executor 有模型未显式钉死，宿主默认模型变更后 Eval 可能静默卡住"
        )

    src = {}
    for item in sources if isinstance(sources, list) else (sources.get("items") or []):
        if isinstance(item, dict):
            src[item.get("id") or item.get("kind") or "?"] = item.get("state")
    result["sources"] = src
    # mobile Source 在 crew 里默认 disabled（team 与 mobile 只读同一条 mobileq），
    # 此时 GET sources 报 missing，属于预期状态，不算掉线。
    off = {
        k: v
        for k, v in src.items()
        if v not in ("ready", "off", "paused", "missing", None)
    }
    if off:
        result["alerts"].append("Source 异常: " + ", ".join(f"{k}={v}" for k, v in off.items()))

    result["ok"] = not result["alerts"]
    for line in result["alerts"] or ["crew path looks healthy"]:
        print(f"- {line}")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
