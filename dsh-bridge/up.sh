#!/bin/bash
# 把 backend 装进一个 dsh profile 并起来。每一步失败就停，不静默。
#
#   ./up.sh --profile crew
#
# 可重复执行：profile 已存在就复用，配置已写过就跳过，服务已在跑就只报告。
set -u

REPO=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$REPO/backend"
PROFILE=crew
STATE_DIR=""
NO_WEB=0
RESTART=0

usage() {
  cat <<'EOF'
用法: up.sh [--profile <名字>] [--state-dir <绝对路径>] [--no-web] [--restart] [--help]

  --profile      dsh profile 名，默认 crew
  --state-dir    后端状态目录，默认 $HOME/.dsh/state/<profile>
  --no-web       关闭 Web listener、页面运行时、客户端模块和 HMR，保留 host 服务与移动端 API
  --restart      配置完成后先优雅停止，再启动该 profile
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=${2:-}; shift 2 ;;
    --state-dir) STATE_DIR=${2:-}; shift 2 ;;
    --no-web) NO_WEB=1; shift ;;
    --restart) RESTART=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "up.sh: 不认识的参数 $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$PROFILE" ] || { echo "up.sh: --profile 需要一个名字" >&2; exit 2; }

DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
STATE_DIR=${STATE_DIR:-$DSH_HOME/state/$PROFILE}

# gateway 的端口由状态目录推出来，不是写死的。规则与 backend/scripts/dsh-superagent 的
# state_dir_identity 一致：默认目录仍是 8788，换一个目录就换一个端口，重启不变。
if [ "$(cd "$STATE_DIR" 2>/dev/null && pwd)" = "$DSH_HOME/state/superagent" ]; then
  GATEWAY_PORT=8788
else
  GATEWAY_PORT=$(( 18800 + $(printf '%s' "$STATE_DIR" | od -An -tuC -v | tr -s ' ' '\n' | awk 'NF{s+=$1} END{print s+0}') % 100 ))
fi
TOKEN_FILE="$STATE_DIR/mobilegw.token"

say() { printf '%s\n' "$*"; }
die() { printf 'up.sh: %s\n' "$*" >&2; exit 1; }

# 1. dsh 在不在
command -v dsh >/dev/null 2>&1 || die "找不到 dsh 命令。装法见 backend/docs/006-deployment.md 的 Install 一节。"

# 2. backend 装得上吗
[ -f "$BACKEND/package.json" ] || die "找不到 $BACKEND/package.json —— 这个脚本要在本仓库里跑。"
[ -d "$BACKEND/lib" ] || die "backend 还没构建。先跑: cd backend && pnpm install && pnpm build"

# 3. profile
if [ ! -d "$PROFILE_DIR" ]; then
  say "创建 profile $PROFILE"
  dsh "$PROFILE" --from-default-profile web --dump-config >/dev/null 2>&1 \
    || die "创建 profile $PROFILE 失败（这一步会按 web 模板生成，见 backend/docs/006-deployment.md）"
fi

# 4. 装 bundle（本地 link 与 bundle 声明都存在才跳过）
if python3 - "$PROFILE_DIR/package.json" "$BACKEND" <<'PY'
import json
import sys
from pathlib import Path
try:
    package = json.loads(Path(sys.argv[1]).read_text())
    dependency = package.get('dependencies', {}).get('dsh-superagent')
    bundles = package.get('dsh', {}).get('profile', {}).get('bundles', [])
    sys.exit(0 if dependency == 'link:' + sys.argv[2] and 'dsh-superagent' in bundles else 1)
except (OSError, ValueError, AttributeError):
    sys.exit(1)
PY
then
  say "bundle 已装，跳过"
else
  say "把 backend 装进 profile $PROFILE"
  dsh plugin --profile "$PROFILE" add "link:$BACKEND" || die "安装 bundle 失败"
fi

# 5. 配置：只在没有 dsh-superagent 条目时追加，绝不覆盖已有内容
mkdir -p "$STATE_DIR"
PATCH="$PROFILE_DIR/cordis.patch.yml"
if [ ! -f "$PATCH" ]; then
  printf '%s\n' "[]" > "$PATCH"
fi
python3 - "$PATCH" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
lines = path.read_text().splitlines(keepends=True)
if any(line.strip() == '[]' and line == line.lstrip() for line in lines):
    path.write_text(''.join(line for line in lines if not (line.strip() == '[]' and line == line.lstrip())))
PY
if [ "$NO_WEB" -eq 1 ]; then
  say "关闭 profile $PROFILE 的 Web 模块"
  python3 - "$PATCH" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
lines = path.read_text().splitlines(keepends=True)
wanted = ('webserver', 'web-runtime', 'modules', 'client-hmr', 'open-in-app', 'directory-picker', 'harness-dev-context')
newline = chr(10)
starts = [i for i, line in enumerate(lines) if line.startswith('- id:')]
found = set()
for offset in reversed(range(len(starts))):
    start = starts[offset]
    end = starts[offset + 1] if offset + 1 < len(starts) else len(lines)
    plugin = lines[start][len('- id:'):].strip().strip(" '\"")
    if plugin not in wanted:
        continue
    found.add(plugin)
    disabled = next((i for i in range(start + 1, end) if lines[i].startswith('  disabled:')), None)
    if disabled is None:
        lines.insert(start + 1, '  disabled: true' + newline)
    else:
        ending = newline if lines[disabled].endswith(newline) else ''
        comment = '  #' + lines[disabled].split('#', 1)[1].rstrip(newline) if '#' in lines[disabled] else ''
        lines[disabled] = '  disabled: true' + comment + ending
for plugin in wanted:
    if plugin not in found:
        if lines and not lines[-1].endswith(newline):
            lines[-1] += newline
        lines.extend([f'- id: {plugin}' + newline, '  disabled: true' + newline])
path.write_text(''.join(lines))
PY
fi
if grep -q '^ *- id: dsh-superagent$' "$PATCH"; then
  say "profile 配置已有 dsh-superagent 条目，跳过（要改状态目录请手工编辑 ${PATCH}）"
else
  say "写入 profile 配置"
  {
    printf '\n# added by dsh-bridge/up.sh\n'
    printf -- '- id: dsh-superagent\n  config:\n    stateDir: %s\n' "$STATE_DIR"
  } >> "$PATCH"
fi

# 6. 起服务
ACTION=start
[ "$RESTART" -eq 1 ] && ACTION=restart
say "$([ "$RESTART" -eq 1 ] && echo '重启' || echo '启动') backend（profile ${PROFILE}）"
START_STATUS=0
if "$BACKEND/scripts/dsh-superagent" --profile "$PROFILE" "$ACTION"; then
  :
else
  START_STATUS=$?
  if [ "$NO_WEB" -ne 1 ] || [ "$START_STATUS" -ne 3 ]; then
    die "backend 启动未完成，看 $BACKEND/.artifacts 下最新的日志"
  fi
fi

# 7. 报告
say ""
say "profile   $PROFILE"
say "state     $STATE_DIR"
if [ -f "$TOKEN_FILE" ]; then
  say "gateway   http://127.0.0.1:$GATEWAY_PORT  token $TOKEN_FILE"
else
  say "gateway   还没写 token —— 它由 gateway 首次启动时生成，确认 backend/scripts/dsh-superagent 的 ensure_gateway 跑过"
fi
if [ "$NO_WEB" -eq 1 ]; then
  HEALTH_URL=$("$BACKEND/scripts/dsh-superagent" --profile "$PROFILE" status 2>/dev/null | python3 -c 'import json,sys; url=json.load(sys.stdin).get("url"); print(url.rstrip("/")+"/orchestrator/api/state" if url else "pending")')
  say "health    $HEALTH_URL"
  say "面板      Web 已关闭"
else
  say "面板      $(grep -oh 'http://[0-9.]*:[0-9]*/?token=[A-Za-z0-9_-]*' "$BACKEND"/.artifacts/dsh-superagent-"$PROFILE"-*.log 2>/dev/null | tail -1)"
fi
if [ "$START_STATUS" -eq 3 ]; then
  exit 3
fi
