#!/usr/bin/env bash
#
# cloudflare/start.sh — Cloudflare Tunnel in front of the Antigravity web UI.
#
# Why: a cheap frp node is often bandwidth-bursty (we measured 0.14–7 MB/s for
# the same 3.8 MB bundle), which makes the first load randomly spin for 30 s.
# Cloudflare was a steady ~3 MB/s from the same host, plus it gives a valid
# HTTPS certificate (no "not private" warning on the phone).
#
# Two modes:
#   * named  — if cloudflare/tunnel_token exists: `cloudflared tunnel run --token-file`
#              → stable hostname (e.g. https://antigravity.example.com), see
#                scripts/setup-cloudflare-tunnel.py
#   * quick  — otherwise: a trycloudflare.com URL (no account needed, random
#              hostname, changes on every restart)
#
# Usage: cloudflare/start.sh [start|stop|status|url]
#
# Env:
#   PORT=8790                  local web UI proxy port
#   CF_BIN=...                 cloudflared binary (default: cloudflared in PATH)
#   CONNECT_PROXY=...          optional HTTP proxy for the connector itself, for
#                              hosts that cannot reach the Cloudflare edge
#                              directly (pair it with PROXY_FORWARD from
#                              scripts/start-mobile-web.sh)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8790}"
CF_BIN="${CF_BIN:-cloudflared}"
CONNECT_PROXY="${CONNECT_PROXY:-}"
SESSION="${SESSION:-antigravity-cf}"
LOG="$HERE/cloudflared.log"
TOKEN_FILE="$HERE/tunnel_token"

log() { printf '[cf] %s\n' "$*"; }

current_url() { grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$LOG" 2>/dev/null | head -1; }

case "${1:-start}" in
  start)
    [ -x "$CF_BIN" ] || { log "ERROR: cloudflared not found: $CF_BIN"; exit 1; }
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    : > "$LOG"
    if [ -s "$TOKEN_FILE" ]; then
      log "starting NAMED tunnel (token from $TOKEN_FILE)"
      tmux new-session -d -s "$SESSION" -c "$HERE" \
        "HTTPS_PROXY=$CONNECT_PROXY HTTP_PROXY=$CONNECT_PROXY ALL_PROXY=$CONNECT_PROXY \
         '$CF_BIN' tunnel --no-autoupdate --protocol http2 run --token-file '$TOKEN_FILE' 2>&1 | tee '$LOG'"
    else
      log "starting QUICK tunnel (trycloudflare.com, random hostname)"
      tmux new-session -d -s "$SESSION" -c "$HERE" \
        "HTTPS_PROXY=$CONNECT_PROXY HTTP_PROXY=$CONNECT_PROXY ALL_PROXY=$CONNECT_PROXY \
         '$CF_BIN' tunnel --no-autoupdate --protocol http2 --url https://127.0.0.1:$PORT --no-tls-verify 2>&1 | tee '$LOG'"
    fi
    for _ in $(seq 1 40); do
      if [ -s "$TOKEN_FILE" ]; then
        if grep -q "Registered tunnel connection" "$LOG" 2>/dev/null; then break; fi
      else
        if [ -n "$(current_url)" ]; then break; fi
      fi
      sleep 1
    done
    if [ -s "$TOKEN_FILE" ]; then
      log "named tunnel up (hostname is whatever you configured in Cloudflare)"
    else
      url="$(current_url)"
      [ -n "$url" ] || { log "ERROR: no quick-tunnel URL in $LOG"; tail -10 "$LOG"; exit 1; }
      log "public URL: $url"
    fi
    ;;
  url)
    url="$(current_url)"; echo "${url:-(none)}"
    ;;
  status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      log "running (tmux: $SESSION)"
      [ -s "$TOKEN_FILE" ] && log "mode: named" || log "url: $(current_url)"
      grep -c "Registered tunnel connection" "$LOG" 2>/dev/null | sed 's/^/connections: /'
    else
      log "not running"
    fi
    ;;
  stop)
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    log "stopped"
    ;;
  *)
    echo "usage: $0 [start|stop|status|url]" >&2; exit 2 ;;
esac
