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

# 4) 代码行渲染：两端必须逐字保留 text（行首空白 + 前导 +/-）。
#    手机端曾在 CodeSyntax.segments 里 trimStart().trimStart('+','-').trimStart()，
#    桌面端从不剥——同一行两端差几个空格，--gap 甚至会被吃掉两个减号。
#    上面 1–3 项只查「某个字面量在不在」，查不到「两边都有实现、行为却不同」的分叉。
# 4a) 渲染层不许再剥行首。
if grep -Eq "trimStart\('\+'" app/app/src/main/java/com/dsh/botcrew/CrewWire.kt; then
  echo "parity: 手机端渲染层又在剥代码行行首（该在解析层还原）"
  fail=1
fi
if grep -Eq 'TrimLeft\(|TrimPrefix\(line\.Text|TrimSpace\(line\.Text' desktop/syntax.go desktop/ui.go; then
  echo "parity: 桌面端渲染层在剥代码行行首"
  fail=1
fi

# 4b) 解析层那条「只剥匹配前缀」的判据两端必须一字不差（与第 1 项同理）。
go_rule=$(grep -o "text\[0\] == sign && text\[1\] == ' '" desktop/client.go | head -1)
kt_rule=$(grep -o "text\[0\] == sign && text\[1\] == ' '" app/app/src/main/java/com/dsh/botcrew/CrewWire.kt | head -1)
if [ "$go_rule" != "$kt_rule" ] || [ -z "$go_rule" ]; then
  echo "parity: 代码行前缀还原判据不一致 go=$go_rule kt=$kt_rule"
  fail=1
fi

# 5) 同一批输入、同一批期望：两端测试里的 parity-fixture 行必须一字不差。
#    这是行为级守门——两端各自的单测再绿，也可能各自断言了不同的期望。
go_fixtures=$(grep -h 'parity-fixture:' desktop/code_test.go | sed 's/^[[:space:]]*//' | sort)
kt_fixtures=$(grep -h 'parity-fixture:' app/app/src/test/java/com/dsh/botcrew/CrewWireTest.kt | sed 's/^[[:space:]]*//' | sort)
if [ "$go_fixtures" != "$kt_fixtures" ] || [ -z "$go_fixtures" ]; then
  echo "parity: 两端代码行 fixture 不一致（或缺失）"
  printf '  go: %s\n  kt: %s\n' "$go_fixtures" "$kt_fixtures"
  fail=1
fi

# 6) 两端都得有「拼回原文」的回归测试，fixture 才不是摆设。
grep -q 'TestCodeSegmentsKeepTheLinesOwnWhitespaceAndSigns' desktop/code_test.go || { echo "parity: desktop 缺逐字回归测试"; fail=1; }
grep -q 'fun tokenizingNeverDropsCharacters' app/app/src/test/java/com/dsh/botcrew/CrewWireTest.kt || { echo "parity: app 缺逐字回归测试"; fail=1; }

[ "$fail" = "0" ] && echo "parity: 通过"
exit "$fail"
