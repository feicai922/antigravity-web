#!/usr/bin/env bash
#
# start-mobile-web.sh — run the Antigravity web UI on this host, ready for
# remote access (frp tunnel / Tailscale / LAN).
#
# Why this script exists: on Linux the Antigravity "language server" binary is
# `~/.gemini/bin/agy`, which has a different CLI surface from the macOS/Windows
# `language_server` the npm POC was written for. It runs as
#     agy --hub --hub-port=35833 --app_data_dir=antigravity --csrf_token=a6403551-...
# inside a pty (bubbletea TUI) and then serves
#     * the IDE frontend on an ephemeral HTTPS port   <-- that is what we proxy
#     * a small browser UI on the plain-HTTP hub port
# The web POC proxy runs in ATTACH mode against that HTTPS port, adding the
# Electron preload shim and the phone (mobile.css / mobile.js) tweaks.
#
# Usage:
#   scripts/start-mobile-web.sh            # start everything (idempotent)
#   scripts/start-mobile-web.sh status
#   scripts/start-mobile-web.sh stop
#
# Env knobs:
#   PORT=8790              proxy listen port (this is the port you tunnel)
#   WORKSPACE=/data1/workspace   workspace folder the agent works in (default: repo)
#   APP_DATA_DIR=antigravity   conversation namespace under ~/.gemini
#                          (use antigravity_client to run alongside the IDE)
#   HUB_PORT=0             hub port, 0 = random
#   AGY_BIN=~/.gemini/bin/agy
#   MOBILE_UI=1            inject mobile.css / mobile.js
#   PROXY_FORWARD=host:port  optional HTTP CONNECT egress for the language
#                          server, exposed locally through an SSH -L tunnel to
#                          a machine that does have egress. Without it, hosts
#                          that cannot reach oauth2/cloudcode.googleapis.com
#                          show "No Model Selected" in the UI.
#   LOCAL_PROXY_PORT=7999  local port used by PROXY_FORWARD
#   SESSION_PROXY=antigravity-proxy
#   SESSION_LS=antigravity-ls     tmux session for the language server
#   SESSION_WEB=antigravity-web   tmux session for the proxy
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8790}"
WORKSPACE="${WORKSPACE:-$ROOT}"
APP_DATA_DIR="${APP_DATA_DIR:-antigravity}"
HUB_PORT="${HUB_PORT:-0}"
AGY_BIN="${AGY_BIN:-$HOME/.gemini/bin/agy}"
MOBILE_UI="${MOBILE_UI:-1}"
PROXY_FORWARD="${PROXY_FORWARD:-}"
LOCAL_PROXY_PORT="${LOCAL_PROXY_PORT:-7999}"
SESSION_PROXY="${SESSION_PROXY:-antigravity-proxy}"
TOKEN_FILE="$ROOT/.mobile-web/auth_token"
SESSION_LS="${SESSION_LS:-antigravity-ls}"
SESSION_WEB="${SESSION_WEB:-antigravity-web}"
CSRF_FILE="$ROOT/.mobile-web/csrf_token"

# `npx tsx` costs ~12 s on this NFS checkout (npx re-resolves the package), and
# every second of it is a "connection refused" burst in frpc's log because the
# tunnel is up while 127.0.0.1:8790 is not. Calling the local tsx entry point
# directly brings the proxy up in ~1 s.
# 优先跑预编译产物：`node dist/...` 起服务只要 ~1 s（attach 模式不再加载 protobuf），
# 而 tsx 现场编译这套 NFS 上的源码要 10–30 s —— 这段时间 8790 是关的，frpc 会为每个
# 进来的连接记一行 "connection refused"。dist 落后于源码时退回 tsx，并提示去 build。
DIST_ENTRY="$ROOT/dist/src/server/web-poc/server.js"
dist_is_fresh() {
  [ -f "$DIST_ENTRY" ] || return 1
  local newest
  newest="$(find "$ROOT/src" -newer "$DIST_ENTRY" -print -quit 2>/dev/null)"
  [ -z "$newest" ]
}
if dist_is_fresh; then
  TSX_CMD="node $DIST_ENTRY"
elif [ -f "$ROOT/node_modules/tsx/dist/cli.mjs" ]; then
  TSX_CMD="node $ROOT/node_modules/tsx/dist/cli.mjs"
else
  TSX_CMD="npx tsx"
fi
LS_LOG="$ROOT/.mobile-web/ls.log"
WEB_LOG="$ROOT/.mobile-web/web.log"
PID_DIR="$ROOT/.mobile-web"

log() { printf '[mobile-web] %s\n' "$*"; }
die() { printf '[mobile-web] ERROR: %s\n' "$*" >&2; exit 1; }

# --- helpers ----------------------------------------------------------------

# Ports this pid is LISTENing on.
listening_ports() {
  local pid="$1"
  ss -ltnp 2>/dev/null | awk -v p="pid=$pid," 'index($0, p) { n = split($4, a, ":"); print a[n] }'
}

# The frontend port answers HTTPS and returns the Antigravity HTML.
is_frontend_port() {
  local p="$1"
  curl -sk -m 3 "https://127.0.0.1:$p/" 2>/dev/null | grep -q '<title>Antigravity'
}

# Pid of the running agy hub process.
# `pgrep -f` alone also matches the wrapper shell (`env … agy --hub … | tee`),
# so we compare the resolved /proc/PID/exe against the binary path as well.
agy_pid() {
  local p want
  want="$(readlink -f "$AGY_BIN" 2>/dev/null || echo "$AGY_BIN")"
  for p in $(pgrep -f " --hub --hub-port=" 2>/dev/null || true); do
    if [ "$(readlink -f "/proc/$p/exe" 2>/dev/null)" = "$want" ]; then
      echo "$p"; return 0
    fi
  done
  return 0
}

find_frontend_port() {
  local pid="$1" p
  for p in $(listening_ports "$pid"); do
    if is_frontend_port "$p"; then echo "$p"; return 0; fi
  done
  return 1
}

wait_frontend_port() {
  local pid="$1" i
  for i in $(seq 1 60); do
    local p
    p="$(find_frontend_port "$pid" || true)"
    if [ -n "$p" ]; then echo "$p"; return 0; fi
    sleep 1
  done
  return 1
}

# --- commands ---------------------------------------------------------------

cmd_status() {
  local pid
  pid="$(agy_pid)"
  [ -n "$pid" ] && log "language server pid: $pid" || log "language server: not running"
  if [ -n "$pid" ]; then
    local fe
    fe="$(find_frontend_port "$pid" || true)"
    log "frontend (HTTPS): ${fe:-unknown}"
  fi
  if curl -sk -m 3 -o /dev/null "https://127.0.0.1:$PORT/" 2>/dev/null; then
    log "proxy: listening on https://0.0.0.0:$PORT/"
  else
    log "proxy: not listening on $PORT"
  fi
}

cmd_stop() {
  tmux kill-session -t "$SESSION_WEB" 2>/dev/null || true
  tmux kill-session -t "$SESSION_LS" 2>/dev/null || true
  [ -n "${PROXY_FORWARD:-}" ] && tmux kill-session -t "$SESSION_PROXY" 2>/dev/null || true
  log "stopped (tmux sessions $SESSION_WEB / $SESSION_LS / $SESSION_PROXY)"
}

# Start (or reuse) the SSH -L tunnel that gives this host HTTP egress.
ensure_proxy_forward() {
  [ -n "$PROXY_FORWARD" ] || return 0
  local host="${PROXY_FORWARD%%:*}" port="${PROXY_FORWARD##*:}"
  if curl -s -m 3 -x "http://127.0.0.1:$LOCAL_PROXY_PORT" -o /dev/null "https://oauth2.googleapis.com/" 2>/dev/null; then
    log "proxy forward already up on 127.0.0.1:$LOCAL_PROXY_PORT"
    return 0
  fi
  log "starting SSH forward 127.0.0.1:$LOCAL_PROXY_PORT -> $host:127.0.0.1:$port"
  tmux kill-session -t "$SESSION_PROXY" 2>/dev/null || true
  tmux new-session -d -s "$SESSION_PROXY" \
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 -N -L 127.0.0.1:$LOCAL_PROXY_PORT:127.0.0.1:$port $host"
  local i
  for i in $(seq 1 15); do
    if curl -s -m 3 -x "http://127.0.0.1:$LOCAL_PROXY_PORT" -o /dev/null "https://oauth2.googleapis.com/" 2>/dev/null; then
      log "proxy forward ready"
      return 0
    fi
    sleep 1
  done
  die "proxy forward to $PROXY_FORWARD failed; see: tmux attach -t $SESSION_PROXY"
}

cmd_start() {
  [ -x "$AGY_BIN" ] || die "language server binary not found: $AGY_BIN"
  command -v tmux >/dev/null || die "tmux not found"
  mkdir -p "$PID_DIR"

  # Access token: created on first run, reused on restart so the phone stays
  # logged in; `start-mobile-web.sh token` prints it, `--rotate` replaces it.
  mkdir -p "$(dirname "$TOKEN_FILE")"
  if [ "${AUTH:-on}" != "off" ] && [ ! -s "$TOKEN_FILE" ]; then
    python3 -c "import secrets;print(secrets.token_urlsafe(24))" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
    log "生成了新的访问令牌(已存到 $TOKEN_FILE)"
  fi

  ensure_proxy_forward

  # 1. Language server -----------------------------------------------------
  local pid fe
  pid="$(agy_pid)"
  if [ -n "$pid" ] && [ ! -s "$CSRF_FILE" ]; then
    log "found an untracked language server (pid $pid, no CSRF on disk) — restarting it"
    kill -9 "$pid" 2>/dev/null || true
    tmux kill-session -t "$SESSION_LS" 2>/dev/null || true
    sleep 2
    pid=""
  fi
  if [ -n "$pid" ]; then
    log "language server already running (pid $pid), reusing it"
  else
    if [ ! -s "$CSRF_FILE" ]; then
      cat /proc/sys/kernel/random/uuid > "$CSRF_FILE"
    fi
    local csrf hub
    csrf="$(cat "$CSRF_FILE")"
    hub="$HUB_PORT"
    if [ "$hub" = "0" ]; then
      # agy needs a concrete hub port (it prints it as the browser URL).
      hub="$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
)"
    fi
    log "starting language server (app_data_dir=$APP_DATA_DIR, hub_port=$hub)"
    tmux kill-session -t "$SESSION_LS" 2>/dev/null || true
    # AGY_ENABLE_HUB=1 is what makes the binary serve the frontend at all.
    local proxy_env=""
    if [ -n "$PROXY_FORWARD" ]; then
      proxy_env="HTTP_PROXY=http://127.0.0.1:$LOCAL_PROXY_PORT HTTPS_PROXY=http://127.0.0.1:$LOCAL_PROXY_PORT ALL_PROXY=http://127.0.0.1:$LOCAL_PROXY_PORT NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,.cluster.lan"
    fi
    tmux new-session -d -s "$SESSION_LS" -c "$ROOT" \
      "env AGY_ENABLE_HUB=1 ANTIGRAVITY_VSCODE_HOST=1 $proxy_env \
        '$AGY_BIN' --hub --hub-port=$hub --app_data_dir='$APP_DATA_DIR' \
        --csrf_token=$csrf --add-dir='$WORKSPACE' 2>&1 | tee '$LS_LOG'"
    sleep 2
    pid="$(agy_pid)"
    [ -n "$pid" ] || die "language server failed to start; see: tmux attach -t $SESSION_LS"
  fi

  # 2. Frontend port -------------------------------------------------------
  log "waiting for the frontend port…"
  fe="$(wait_frontend_port "$pid")" || die "frontend port never appeared; see $LS_LOG"
  log "frontend (HTTPS): $fe"

  local csrf
  csrf="$(cat "$CSRF_FILE")"

  # 3. Proxy ---------------------------------------------------------------
  if curl -sk -m 3 -o /dev/null "https://127.0.0.1:$PORT/" 2>/dev/null; then
    log "proxy already listening on $PORT, restarting it"
    tmux kill-session -t "$SESSION_WEB" 2>/dev/null || true
    sleep 1
  fi
  local ENTRY_ARG="src/server/web-poc/server.ts"
  if dist_is_fresh; then
    ENTRY_ARG=""
  else
    log "提示: dist 落后于源码(或不存在),本次用 tsx 直接跑源码,启动会慢 10–30s;可先跑 npm run build"
  fi
  log "starting proxy on port $PORT (mobile UI: $MOBILE_UI)"
  tmux new-session -d -s "$SESSION_WEB" -c "$ROOT" \
    "env PORT=$PORT AG_ATTACH_URL=https://127.0.0.1:$fe AG_CSRF_TOKEN=$csrf MOBILE_UI=$MOBILE_UI \
      $TSX_CMD $ENTRY_ARG '$WORKSPACE' 2>&1 | tee '$WEB_LOG'"

  # 4. Smoke test ----------------------------------------------------------
  # With the token gate on, an unauthenticated request legitimately returns the
  # login page, so probe with the token (or accept the login page as "up").
  local token="" auth_hdr=()
  if [ "${AUTH:-on}" != "off" ] && [ -s "$TOKEN_FILE" ]; then
    token="$(cat "$TOKEN_FILE")"
    auth_hdr=(-H "Cookie: ag_auth=$token")
  fi
  local i ok=0
  for i in $(seq 1 60); do
    if curl -sk -m 3 "${auth_hdr[@]}" "https://127.0.0.1:$PORT/" 2>/dev/null | grep -q 'Antigravity'; then ok=1; break; fi
    sleep 1
  done
  [ "$ok" = "1" ] || die "proxy started but the UI is not reachable; see $WEB_LOG"

  log "ready:  https://127.0.0.1:$PORT/   (upstream https://127.0.0.1:$fe)"
  if [ -n "$token" ]; then
    log "访问令牌: $token"
    log "本地打开: https://127.0.0.1:$PORT/?t=$token"
    [ -n "${PUBLIC_HOST:-}" ] && log "公网打开: https://$PUBLIC_HOST/?t=$token"
  else
    log "AUTH=off:无需令牌"
  fi
  log "tmux:   tmux attach -t $SESSION_WEB   |   tmux attach -t $SESSION_LS"
}

case "${1:-start}" in
  start) cmd_start ;;
  token)
    if [ "${2:-}" = "--rotate" ]; then
      python3 -c "import secrets;print(secrets.token_urlsafe(24))" > "$TOKEN_FILE"
      chmod 600 "$TOKEN_FILE"
      log "令牌已轮换;重启代理后生效:./scripts/start-mobile-web.sh start"
    fi
    [ -s "$TOKEN_FILE" ] && cat "$TOKEN_FILE" || log "(还没有令牌)"
    ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *) die "unknown command: $1 (use start|stop|status)" ;;
esac
