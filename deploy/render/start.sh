#!/bin/bash
# Public process: Next.js on ${PORT:-4317}. API on 127.0.0.1:8787 only.
# Render sets PORT and NODE_ENV. The API must not inherit either: PORT would
# steal the public port, and NODE_ENV=production refuses DEMO_MODE.
set -eu

append_origin() {
  local base="$1"
  local extra="$2"
  if [ -z "$extra" ]; then
    printf '%s' "$base"
    return
  fi
  case ",${base}," in
    *",${extra},"*) printf '%s' "$base" ;;
    *)
      if [ -z "$base" ]; then
        printf '%s' "$extra"
      else
        printf '%s,%s' "$base" "$extra"
      fi
      ;;
  esac
}

web_origin="${WEB_ORIGIN:-https://staging.nexafi.io}"
web_origin="$(append_origin "$web_origin" "${RENDER_EXTERNAL_URL:-}")"
export WEB_ORIGIN="$web_origin"

public_port="${PORT:-4317}"
api_port="${API_PORT:-8787}"

cd /app/apps/api
NODE_ENV=staging \
  PORT="$api_port" \
  HOST=127.0.0.1 \
  WEB_ORIGIN="$web_origin" \
  ./node_modules/.bin/tsx src/index.ts &
api_pid=$!

cd /app/apps/web
NODE_ENV=production \
  PORT="$public_port" \
  API_URL="http://127.0.0.1:${api_port}" \
  API_PROXY_TARGET="${API_PROXY_TARGET:-http://127.0.0.1:${api_port}}" \
  ./node_modules/.bin/next start --hostname 0.0.0.0 --port "$public_port" &
web_pid=$!

shutdown() {
  kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
  wait "$web_pid" 2>/dev/null || true
}

trap 'shutdown; exit 0' TERM INT

set +e
wait -n
status=$?
set -e
shutdown
exit "$status"
