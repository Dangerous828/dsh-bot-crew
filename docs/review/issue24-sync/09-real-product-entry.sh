#!/usr/bin/env bash
# #24 09 真运行入口闭环（可复现，脱敏）。
# 前置：生产 DSH 已部署本 seam（lib e39f323c+）、win-desktop 有 C:/Users/xc/wb-b/{src,b-run.ts}。
# 全程真实产品入口：管理面 loopback 出码 → lan pair 兑码 → 真 send(memory.hear) → 真 edit(toHub) → 真 forget。
# token 由兑码动态获取，仅进程内变量，不落文件/日志。canary 用唯一 MARK，测后清理（见末尾）。
set -euo pipefail
MGMT='http://127.0.0.1:3082'          # 生产管理面（loopback，Host 需 127.0.0.1:3082）
LAN='http://192.168.31.127:43499'     # 生产 lan-server 端口
DEV="wb-sync-verify-$RANDOM"
MARK=$(date +%s)
MARKER="wb-sync 验收 canary $MARK"

echo "== 1) 出码（管理面 loopback）"
CODE=$(curl -s -H 'Host:127.0.0.1:3082' -H 'x-orchestrator-request:1' -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:3082' -X POST -d "{\"deviceId\":\"$DEV\"}" $MGMT/orchestrator/api/remote/pairing \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["code"])')
echo "code=$CODE device=$DEV"

echo "== 2) 兑码换明文 token（lan，仅内存）"
TOKEN=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceId\":\"$DEV\",\"name\":\"$DEV\",\"platform\":\"mac\"}" $LAN/api/mobile/pair \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
AUTH=(-H "x-crew-device: $DEV" -H "x-crew-credential: $TOKEN")

echo "== 3) 真 send（human trigger → Runtime.memory.hear → ledger.settle 生成记忆，person:owner）"
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"text\":\"以后都记一条：$MARKER，这是受控测试事实请记住\",\"request_id\":\"wb-sync-verify-$MARK\"}" \
  $LAN/api/mobile/send | tee /tmp/09-send.json; echo
sleep 3
NAME=$(curl -s "${AUTH[@]}" $LAN/api/mobile/memory \
  | python3 -c "import sys,json;its=json.load(sys.stdin)['items'];print([i['name'] for i in its if 'canary-$MARK' in i['name']][0])")
echo "generated name=$NAME (断言 to_hub=false 见 memory 列表)"

echo "== 4) 真 edit 置 toHub:true（→runtime.editMemory→ledger.edit→author.publish 落 md 上行）"
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"action\":\"edit\",\"name\":\"$NAME\",\"toHub\":true}" $LAN/api/mobile/memory | tee /tmp/09-edit.json; echo

echo "== 5) 真 pipeline 上行 + B(win-desktop) recall 命中"
~/.home-agent-bridge/dream_notify.sh dsh-memory compact wbsync-$MARK >/dev/null 2>&1 || true
sleep 5
# B 侧（win-desktop）：产品 HubHttp.search 按 bot 检索（token 经 SSH stdin）
HUBTOKEN=$(node --experimental-transform-types -e "import('/Users/cpuser/Code/dsh-bot-crew/backend/src/memory/auth.ts').then(m=>console.log(m.readHubToken({env:'HUB_TOKEN',file:'/Users/cpuser/.config/hub-memory-mcp/env'}).token))")
printf '%s\n' "$HUBTOKEN" | ssh -o ConnectTimeout=20 win-desktop-cf \
  "cd C:/Users/xc/wb-b && set WB_BOT=lead&& set WB_QUERY=$MARKER&& set WB_MARK=$MARK&& node --experimental-transform-types b-run.ts"

echo "== 6) 真 forget（→disabled md + bySourceFile 撤 live + 原子 tombstone）→ B 不再命中/不复活"
curl -s -X POST "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d "{\"action\":\"forget\",\"name\":\"$NAME\"}" $LAN/api/mobile/memory | tee /tmp/09-forget.json; echo
sleep 4
~/.home-agent-bridge/dream_notify.sh dsh-memory compact wbsync-$MARK-b >/dev/null 2>&1 || true
sleep 3
printf '%s\n' "$HUBTOKEN" | ssh -o ConnectTimeout=20 win-desktop-cf \
  "cd C:/Users/xc/wb-b && set WB_BOT=lead&& set WB_QUERY=$MARKER&& set WB_MARK=$MARK&& node --experimental-transform-types b-run.ts"

echo "== 7) 清理：撤销 verify 设备 + 删 canary md/KV 账本行/digest 历史（测试产物，非用户记忆）"
curl -s -H 'Host:127.0.0.1:3082' -H 'x-orchestrator-request:1' -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3082' \
  -X DELETE -d "{\"deviceId\":\"$DEV\"}" $MGMT/orchestrator/api/remote/devices; echo
find ~/.dsh/memory/bot/lead -name "*canary-$MARK*" -delete 2>/dev/null || true
DB=~/.dsh/state/superagent/orchestrator.sqlite
sqlite3 "$DB" "delete from kv where key in ('memory:entry:$NAME','memory:digests:$NAME');"
echo "DONE MARK=$MARK"
