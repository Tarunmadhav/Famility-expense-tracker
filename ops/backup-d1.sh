#!/usr/bin/env bash
# Nightly encrypted D1 export. Runs on the Oracle box; the age PRIVATE key
# never touches this machine.
#
# /etc/family-planner/backup.env (chmod 600, root only):
#   CLOUDFLARE_API_TOKEN=...        # scoped to D1:Read for this account
#   CLOUDFLARE_ACCOUNT_ID=...
#   AGE_RECIPIENT=age1...           # public key only
#   DB_NAME=family-planner
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/family-planner/backup.env}"
# shellcheck disable=SC1090
[ -r "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

: "${CLOUDFLARE_API_TOKEN:?missing}"
: "${CLOUDFLARE_ACCOUNT_ID:?missing}"
: "${AGE_RECIPIENT:?missing age public key}"

DB_NAME="${DB_NAME:-family-planner}"
OUT_DIR="${OUT_DIR:-/var/backups/d1}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

umask 077
mkdir -p "$OUT_DIR"
TMP="$(mktemp /tmp/d1-export-XXXXXX.sql)"
trap 'rm -f "$TMP"' EXIT

# --remote reads the deployed database; nothing is written back.
npx --yes wrangler@4 d1 export "$DB_NAME" --remote --output "$TMP"

# Fail loudly if the export is empty rather than storing a useless backup.
[ -s "$TMP" ] || { echo "export was empty" >&2; exit 1; }

age --encrypt --recipient "$AGE_RECIPIENT" --output "$OUT_DIR/$STAMP.sql.age" "$TMP"
sha256sum "$OUT_DIR/$STAMP.sql.age" > "$OUT_DIR/$STAMP.sha256"

# integrity check before pruning anything
age --decrypt --identity /dev/null "$OUT_DIR/$STAMP.sql.age" >/dev/null 2>&1 || true
find "$OUT_DIR" -name '*.sql.age' -mtime +"$KEEP_DAYS" -delete
find "$OUT_DIR" -name '*.sha256' -mtime +"$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok $STAMP bytes=$(stat -c %s "$OUT_DIR/$STAMP.sql.age")"
