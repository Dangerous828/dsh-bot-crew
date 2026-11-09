#!/bin/bash
# Checks the whole crew path end to end and prints what is wrong, if anything.
# Read-only: it never sends a message, changes settings, or starts a service it did not find.
set -u
fail=0
say() { printf '%-42s %s\n' "$1" "$2"; }
bad() { say "$1" "$2"; fail=1; }

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" pid "$2}'; }

# The backend may bind the loopback or a LAN address, so find which one answers. The Host header stays
# on loopback either way, because that is the authority the management fence accepts.
api() {
  local path="$1" url
  for url in "http://127.0.0.1:3082" "http://$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1):3082"; do
    local body
    body=$(curl -s --max-time 5 -H 'Host: 127.0.0.1:3082' -H 'x-orchestrator-request: 1' "$url/orchestrator/api$path" 2>/dev/null)
    if [ -n "$body" ]; then printf '%s' "$body"; return 0; fi
  done
  return 1
}

# 1. The orchestrator's Web server, on whichever address it bound.
orch=$(port_pid 3082)
[ -n "$orch" ] && say "orchestrator :3082" "$orch" || bad "orchestrator :3082" "not listening — run scripts/dsh-superagent start"

# 2. The phone gateway, which the /api/mobile routes forward to.
gw=$(port_pid 8788)
if [ -n "$gw" ]; then say "mobile gateway :8788" "$gw"
else bad "mobile gateway :8788" "not listening — launchctl load ~/Library/LaunchAgents/com.cpuser.dsh-mobilegw.plist"; fi

# 3. Health of every orchestrator component, through the loopback Host the fence accepts.
health=$(api "/state")
if [ -z "$health" ]; then bad "orchestrator health" "no answer"
else
  python3 - "$health" <<'PY'
import json, sys
data = json.loads(sys.argv[1])
bad = 0
for name, entry in (data.get('health') or {}).items():
    state = entry.get('state')
    if state not in ('ready', 'paused'):
        print(f'  {name:12} {state:9} {entry.get("detail", "")[:60]}')
        bad = 1
team = (data.get('health') or {}).get('team', {})
print(f'  crew Source  {team.get("state", "?"):9} {team.get("detail", "")[:60]}')
sys.exit(bad)
PY
  [ $? -eq 0 ] || fail=1
fi

# 4. A model must be pinned, or an Eval can sit in `evaluating` forever behind a bad host default.
for block in eval executor; do
  value=$(api "/settings" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['blocks']['$block']['value'].get('model')))" 2>/dev/null)
  case "$value" in
    null|"") bad "$block model" "unset — run scripts/configure.py (a bad host default stalls every Eval)" ;;
    *) say "$block model" "$value" ;;
  esac
done

# 5. The roster the phone actually receives, read through the same timeline the app uses. It must name
#    exactly one default Bot, or routing has no fallback for a message that mentions nobody.
token=$(grep -ho 'token=[A-Za-z0-9_-]*' backend/.artifacts/dsh-superagent-superagent-*.log 2>/dev/null | tail -1 | cut -d= -f2)
origin=$(lsof -nP -iTCP:3082 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{split($9,a,":"); print a[1]}')
if [ -z "$token" ] || [ -z "$origin" ]; then
  bad "crew roster" "cannot read the login token or the bound address"
else
  cookie=$(curl -s -i --max-time 5 "http://$origin:3082/?token=$token" 2>/dev/null \
    | grep -i '^set-cookie:' | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
  roster=$(curl -s --max-time 5 -H "Cookie: $cookie" "http://$origin:3082/api/mobile/timeline" 2>/dev/null)
  if [ -z "$roster" ]; then
    bad "crew roster" "the phone timeline did not answer"
  else
    printf '%s' "$roster" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("unreadable timeline")
    sys.exit(1)
bots = data.get("bots") or []
named = data.get("default_bot_id") or ""
defaults = [bot for bot in bots if bot.get("role") == "default"]
ok = len(bots) > 0 and len(defaults) == 1 and named == defaults[0].get("id")
names = ", ".join(f"{bot.get(chr(105)+chr(100))}={bot.get(chr(110)+chr(97)+chr(109)+chr(101))}" for bot in bots)
print(f"{len(bots)} bots ({names}), default {named or chr(45)}" + ("" if ok else " NEEDS FIX"))
sys.exit(0 if ok else 1)
' > /tmp/crew-roster-check 2>&1 || fail=1
    say "crew roster" "$(cat /tmp/crew-roster-check)"
  fi
fi

echo
[ $fail -eq 0 ] && echo "crew path looks healthy" || echo "fix the lines above, then re-run"
exit $fail
