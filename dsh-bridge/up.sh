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

usage() {
  cat <<'EOF'
用法: up.sh [--profile <名字>] [--state-dir <绝对路径>] [--help]

  --profile      dsh profile 名，默认 crew
  --state-dir    后端状态目录，默认 $HOME/.dsh/state/<profile>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=${2:-}; shift 2 ;;
    --state-dir) STATE_DIR=${2:-}; shift 2 ;;
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
if [ "$(cd "$STATE_DIR" 2>/dev/null && pwd)" = "$HOME/.dsh/state/superagent" ]; then
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

# 4. 装 bundle（已装则跳过）
if dsh plugin --profile "$PROFILE" why dsh-superagent >/dev/null 2>&1; then
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
if grep -q '^ *- id: dsh-superagent$' "$PATCH"; then
  say "profile 配置已有 dsh-superagent 条目，跳过（要改状态目录请手工编辑 $PATCH）"
else
  say "写入 profile 配置"
  {
    printf '\n# added by dsh-bridge/up.sh\n'
    printf -- '- id: dsh-superagent\n  config:\n    stateDir: %s\n' "$STATE_DIR"
  } >> "$PATCH"
fi

# 6. 起服务
say "启动 backend（profile $PROFILE）"
"$BACKEND/scripts/dsh-superagent" --profile "$PROFILE" start || die "backend 没起来，看 $BACKEND/.artifacts 下最新的日志"

# 7. 报告
say ""
say "profile   $PROFILE"
say "state     $STATE_DIR"
if [ -f "$TOKEN_FILE" ]; then
  say "gateway   http://127.0.0.1:$GATEWAY_PORT  token $TOKEN_FILE"
else
  say "gateway   还没写 token —— 它由 gateway 首次启动时生成，确认 backend/scripts/dsh-superagent 的 ensure_gateway 跑过"
fi
say "面板      $(grep -oh 'http://[0-9.]*:[0-9]*/?token=[A-Za-z0-9_-]*' "$BACKEND"/.artifacts/dsh-superagent-"$PROFILE"-*.log 2>/dev/null | tail -1)"
