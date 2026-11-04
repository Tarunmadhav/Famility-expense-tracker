#!/usr/bin/env bash
# Five-minute uptime probe. Logs a timestamp and HTTP status only - no bodies,
# no headers, no cookies, no tokens.
set -euo pipefail

URL="${URL:-https://family-finance-planner.tarungudipatimadhav.workers.dev/api/health}"
LOG_DIR="${LOG_DIR:-/var/lib/uptime}"
LOG="$LOG_DIR/probe.log"
mkdir -p "$LOG_DIR"

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$URL" 2>/dev/null || echo 000)"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$ts $code" >> "$LOG"

# keep 30 days of probe lines
if [ "$(wc -l < "$LOG")" -gt 9000 ]; then
  tail -n 8000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

[ "$code" = "200" ] || { echo "$ts probe failed with $code" >&2; exit 1; }
