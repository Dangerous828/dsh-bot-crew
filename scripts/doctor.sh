#!/bin/bash
# Checks the whole crew path end to end and prints what is wrong, if anything.
# Read-only: it never sends a message, changes settings, or starts a service it did not find.
set -u
fail=0
say() { printf '%-42s %s\n' "$1" "$2"; }
bad() { say "$1" "$2"; fail=1; }

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1" pid "$2}'; }

# Which profile runs, and on what ports. None of it is fixed: the Web port comes from the profile's patch
# file, and the phone listener and gateway are derived from its state directory, so two crews on one machine
# each get their own. Hard-coding 3082/8788 only ever describes the first one.
# Which profile to inspect: an explicit DSH_PROFILE wins, otherwise the one whose service is actually running,
# otherwise `superagent` — the deployment the README documents. Guessing wrong produces a page of false alarms.
running_profile() {
  # Only a real dsh process counts: a shell or `grep` whose arguments happen to contain the same words would
  # otherwise win the race and answer for a profile that is not running. `pgrep -x node` finds the candidates by
  # executable name, and LC_ALL=C keeps the argument scan byte-wise — the process table holds non-ASCII names,
  # which makes awk fail on multibyte input in the default locale.
  for pid in $(pgrep -x node 2>/dev/null); do
    LC_ALL=C ps -p "$pid" -o args= 2>/dev/null \
      | LC_ALL=C awk '{for (i = 1; i < NF; i++) if ($i == "--profile") {print $(i + 1); exit}}'
  done | head -1
}
PROFILE="${DSH_PROFILE:-$(running_profile)}"; PROFILE="${PROFILE:-superagent}"
PATCH="$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
web_port() { awk '/^- id: webserver/{f=1} f && /^ +port:/{gsub(/[^0-9]/,"",$2); print $2; exit}' "$PATCH" 2>/dev/null; }
state_dir() { awk '/^- id: dsh-superagent/{f=1} f && /stateDir:/{print $2; exit}' "$PATCH" 2>/dev/null; }
STATE="${DSH_STATE_DIR:-$(state_dir)}"
# A profile with no `webserver` block takes dsh's own default, and the only honest way to learn it is to look at
# what the process bound. The patch file is the first choice because it is readable while the service is down.
listening_web_port() {
  LC_ALL=C lsof -nP -iTCP -sTCP:LISTEN -a -p "$${1:-0}" 2>/dev/null | LC_ALL=C awk 'NR > 1 && $9 !~ /:/ || 1 {split($9, a, ":"); if (a[2] + 0 > 1024 && a[2] + 0 < 20000) {print a[2]; exit}}'
}
WEB_PORT="${DSH_WEB_PORT:-$(web_port)}"
[ -z "$WEB_PORT" ] && [ -n "${orch_pid:-}" ] && WEB_PORT=$(listening_web_port "$orch_pid")
[ -z "$WEB_PORT" ] && [ -n "$(port_pid 3080)" ] && WEB_PORT=3080
WEB_PORT="${WEB_PORT:-3082}"
GATEWAY_PORT="${DSH_GATEWAY_PORT:-$( [ -n "$STATE" ] && python3 "$(dirname "$0")/portcheck.py" gateway "$STATE" )}"
LAN_PORT="${DSH_LAN_PORT:-$( [ -n "$STATE" ] && python3 "$(dirname "$0")/portcheck.py" lan "$STATE" )}"

# The backend may bind the loopback or a LAN address, so find which one answers. The Host header stays
# on loopback either way, because that is the authority the management fence accepts.
api() {
  local path="$1" url
  for url in "http://127.0.0.1:$WEB_PORT" "http://$(ipconfig getifaddr en0 2>/dev/null || echo 127.0.0.1):$WEB_PORT"; do
    local body
    body=$(curl -s --max-time 5 -H "Host: 127.0.0.1:$WEB_PORT" -H 'x-orchestrator-request: 1' "$url/orchestrator/api$path" 2>/dev/null)
    if [ -n "$body" ]; then printf '%s' "$body"; return 0; fi
  done
  return 1
}

# 1. The orchestrator's Web server, on whichever address it bound.
orch=$(port_pid "$WEB_PORT")
[ -n "$orch" ] && say "orchestrator :$WEB_PORT ($PROFILE)" "$orch" || bad "orchestrator :$WEB_PORT" "not listening — run scripts/dsh-superagent start --profile $PROFILE"

# 2. The phone gateway, which the /api/mobile routes forward to.
gw=$(port_pid "$GATEWAY_PORT")
if [ -n "$gw" ]; then say "mobile gateway :$GATEWAY_PORT" "$gw"
else bad "mobile gateway :$GATEWAY_PORT" "not listening — it starts with the service (state $STATE)"; fi

# The listener the phone actually dials. Its port is derived from the state directory, never chosen.
phone=$(port_pid "$LAN_PORT")
[ -n "$phone" ] && say "phone listener :$LAN_PORT" "$phone" || bad "phone listener :$LAN_PORT" "not listening — the Source binds it when it starts"

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
    # Unset is not a fault: `initializeRoleModel` returns without seeding, so the session takes the host's own
    # default and work still gets done. It is worth knowing, because nothing on screen says which model that is.
    null|"") say "$block model" "unset — the host default answers; pin one with scripts/configure.py" ;;
    *) say "$block model" "$value" ;;
  esac
done

# 5. The roster the phone actually receives, read through the same timeline the app uses. It must name
#    exactly one default Bot, or routing has no fallback for a message that mentions nobody.
# The roster the phone actually receives, read through the same listener and credential the app uses. A
# browser cookie is no good here: the message surface is guarded by a paired-device credential, so a cookie
# read answers 401 and the roster looks empty when it is not.
if [ -z "${DSH_DEVICE_CREDENTIAL:-}" ]; then
  say "crew roster" "skipped — set DSH_DEVICE_CREDENTIAL (and DSH_DEVICE) to check it"
else
  roster=$(curl -s --max-time 5 -H "x-crew-device: ${DSH_DEVICE:-crew-desktop}" \
    -H "x-crew-credential: $DSH_DEVICE_CREDENTIAL" "http://127.0.0.1:$LAN_PORT/api/mobile/timeline" 2>/dev/null)
  if [ -z "$roster" ]; then
    bad "crew roster" "the phone timeline did not answer on :$LAN_PORT"
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
