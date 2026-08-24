#!/data/data/com.termux/files/usr/bin/sh
set -eu
APP="$HOME/risuai-kai"
PIDFILE="$APP/kai-server.pid"
NGINX_CONF="$APP/ssl/nginx.conf"
cd "$APP/kai/server"

# --- omniroute sidecar ---
if [ -f "$HOME/omniroute-start.sh" ]; then
  sh "$HOME/omniroute-start.sh" || echo "omniroute sidecar failed to start" >&2
fi

# --- aurora sidecar ---
if [ -x "$HOME/aurora-bin" ]; then
  sh "$HOME/aurora-start.sh" || echo "aurora sidecar failed to start" >&2
fi

if [ -f "$PIDFILE" ]; then
  oldpid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    case "$(tr '\000' ' ' < "/proc/$oldpid/cmdline" 2>/dev/null || true)" in
      *dist/server/src/index.js*) kill "$oldpid"; sleep 1 ;;
      *) echo "Refusing to stop unrelated PID $oldpid" >&2; exit 1 ;;
    esac
  fi
fi
nohup env NODE_ENV=production KAI_PORT=3212 KAI_PUBLIC_URL=https://risuai.work.gd KAI_TRUST_PROXY=true node --max-old-space-size=2048 dist/server/src/index.js >> data/server.stdout.log 2>> data/server.stderr.log < /dev/null &
echo $! > "$PIDFILE"
attempt=0
until curl -fsS --max-time 5 http://127.0.0.1:3212/api/health >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 15 ]; then
    echo "KAI backend did not become healthy within 15 seconds" >&2
    exit 1
  fi
  sleep 1
done
kill -0 "$(cat "$PIDFILE")"
nginx -t -c "$NGINX_CONF"
if [ -f "$APP/ssl/nginx.pid" ] && kill -0 "$(cat "$APP/ssl/nginx.pid")" 2>/dev/null; then
  nginx -c "$NGINX_CONF" -s reload
else
  nginx -c "$NGINX_CONF"
fi
sleep 2
curl -kfsS --max-time 5 -H 'Host: risuai.work.gd' https://127.0.0.1:3211/api/health >/dev/null
RENEW_PIDFILE="$APP/ssl/renew-loop.pid"
renewpid="$(cat "$RENEW_PIDFILE" 2>/dev/null || true)"
if [ -z "$renewpid" ] || ! kill -0 "$renewpid" 2>/dev/null; then
  nohup "$APP/ssl/renew-loop.sh" >> "$APP/kai/server/data/certbot-renew-loop.log" 2>&1 < /dev/null &
  echo $! > "$RENEW_PIDFILE"
fi
echo "KAI started: PID $(cat "$PIDFILE"), backend 3212, HTTP 3210, HTTPS 3211"
