#!/data/data/com.termux/files/usr/bin/sh
# aurora-develop/aurora sidecar for RisuAI-KAI.
#
# Deployed copy lives at `$HOME/aurora-start.sh` on the Termux host and is
# invoked by `risuai-kai/start.sh` before the KAI backend comes up. This file is
# the versioned original. `scripts/deploy.py` does NOT ship it — it only uploads
# the built client and server — so an edit here has to be copied over by hand:
#
#     scp -P 8022 kai/aurora-start.sh u0_a361@192.168.219.101:~/aurora-start.sh
#     ssh -p 8022 u0_a361@192.168.219.101 'kill $(cat ~/aurora/aurora.pid); sh ~/aurora-start.sh'
#
# Bound to loopback on purpose: only the KAI backend on this host talks to it.
# TOOL_CALLING_ENABLED=false keeps the ChatGPT web backend from answering a
# creative-writing prompt with canvas markup (":::writing{...}"), which would
# land verbatim in a roleplay reply.
#
# Multi-account rotation (다계정 돌리기)
# -------------------------------------
# FREE_ACCOUNTS=true makes aurora generate FREE_ACCOUNTS_NUM anonymous ChatGPT
# "device" accounts at boot, each with its own UUID device id, session id,
# browser fingerprint and TLS profile. `Pool.Acquire` round-robins across them,
# so consecutive requests reach ChatGPT as different anonymous visitors and the
# per-device rate limit is effectively divided by the pool size. This is why the
# routing catalog can keep Aurora at priority 1 (see kai/server/src/llm/catalog.ts).
#
# FREE_ACCOUNTS_NUM is pinned here rather than left to aurora's built-in default
# so the pool size is visible and does not silently change on an upstream bump.
# Note the pool only shrinks: an account that fails is marked expired, and the
# 10-minute health check cannot renew a device-UUID account (there is no refresh
# or session token to exchange). Restarting the sidecar mints a fresh pool.
set -eu
APP="$HOME/aurora"
PIDFILE="$APP/aurora.pid"
mkdir -p "$APP"
if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    case "$(tr '\000' ' ' < "/proc/$oldpid/cmdline" 2>/dev/null || true)" in
      *aurora-bin*) echo "aurora already running: $oldpid"; exit 0 ;;
    esac
  fi
fi
cd "$APP"
nohup env SERVER_HOST=127.0.0.1 SERVER_PORT=8080 \
  FREE_ACCOUNTS=true FREE_ACCOUNTS_NUM=1024 \
  STREAM_MODE=true TOOL_CALLING_ENABLED=false ENABLE_HISTORY=false \
  "$HOME/aurora-bin" >> "$APP/aurora.log" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
echo "aurora started: PID $(cat "$PIDFILE"), free-account pool 1024"
