#!/bin/sh
# 两个客户端各有一份「把消息正文解回人话」的实现。
# 它们必须对同一批输入给出同样结果 —— 这类逻辑两端各写一遍，最容易只改一边。
#
# 用法：sh scripts/check-parity.sh
set -e
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

fail=0

# 1) 两端的「像编码才解」判定必须一字不差。
go_pattern=$(grep -o '%\[0-9A-Fa-f\]{2}' desktop/client.go | head -1)
kt_pattern=$(grep -o '%\[0-9A-Fa-f\]{2}' app/app/src/main/java/com/dsh/botcrew/CrewWire.kt | head -1)
if [ "$go_pattern" != "$kt_pattern" ]; then
  echo "parity: 编码判定不一致 go=$go_pattern kt=$kt_pattern"
  fail=1
fi

# 2) 两端都必须有「解不出来就保留原文」的退路。
grep -q 'url.QueryUnescape' desktop/client.go || { echo "parity: desktop 缺解码"; fail=1; }
grep -q 'URLDecoder.decode' app/app/src/main/java/com/dsh/botcrew/CrewWire.kt || { echo "parity: app 缺解码"; fail=1; }

# 3) 子代理标签：两端都必须在没有 label 时退回 id。
grep -q 'node.Label' desktop/ui.go || { echo "parity: desktop 没用 label"; fail=1; }
grep -q 'node.label.ifBlank' app/app/src/main/java/com/dsh/botcrew/CrewUi.kt || { echo "parity: app 没用 label"; fail=1; }

[ "$fail" = "0" ] && echo "parity: 通过"
exit "$fail"
