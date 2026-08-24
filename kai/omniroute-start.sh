#!/data/data/com.termux/files/usr/bin/sh
# OmniRoute sidecar for RisuAI-KAI.
#
# Deployed copy lives at `$HOME/omniroute-start.sh` on the Termux host and is
# invoked by `risuai-kai/start.sh` before the KAI backend comes up.
#
# OmniRoute handles all LLM provider routing for the KAI server.
# API keys and provider configs are stored in its internal SQLite database.
# Bound to loopback on purpose: only the KAI backend on this host talks to it.
#
set -eu
APP="$HOME/.omniroute"
PIDFILE="$APP/server/.pid"
mkdir -p "$APP/server" "$APP/logs"

# Check if OmniRoute is already running
if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    echo "OmniRoute already running: $oldpid"; exit 0
  fi
fi

# Environment: HOSTNAME=0.0.0.0 allows external network access on port 20128.
export NODE_ENV=production
export DATA_DIR="$HOME/.omniroute"
export HOSTNAME=0.0.0.0
export OMNIROUTE_SERVER_HOST=0.0.0.0
export HOST=0.0.0.0
export OMNIROUTE_PORT=20128
export PORT=20128
export OMNIROUTE_MEMORY_MB=1024
export LIVE_WS_HOST=0.0.0.0
export CORS_ALLOW_ALL=true

# Start OmniRoute server via the globally-installed CLI.
nohup omniroute serve --port 20128 --no-open --no-tray >> "$APP/logs/omniroute.log" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
echo "OmniRoute started: PID $(cat "$PIDFILE"), listening on 0.0.0.0:20128"

attempt=0
until curl -fsS --max-time 5 http://127.0.0.1:20128/v1/models >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "OmniRoute did not become healthy within 30 seconds" >&2
    exit 1
  fi
  sleep 1
done
echo "OmniRoute health check passed."
