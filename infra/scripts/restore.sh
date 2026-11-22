#!/usr/bin/env bash
# Restores a backup. Usage: restore.sh <backup-repo-dir> [target-hub-dir] [target-lh-dir]
# Target defaults: HUB_DB=/var/lib/hub/hub.sqlite, LH_DATA_DIR=/var/lib/lh/data.
# Meant for a new VPS already prepared with setup-vps.sh and with the services STOPPED.
set -euo pipefail

SRC="${1:?usage: restore.sh <backup-repo> [HUB_DB] [LH_DATA_DIR]}"
HUB_DB="${2:-${HUB_DB:-/var/lib/hub/hub.sqlite}}"
LH_DATA_DIR="${3:-${LH_DATA_DIR:-/var/lib/lh/data}}"

[[ -f "$SRC/hub/hub.sql" ]] || { echo "restore: $SRC/hub/hub.sql is missing" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "restore: sqlite3 is missing" >&2; exit 1; }
command -v rsync >/dev/null || { echo "restore: rsync is missing" >&2; exit 1; }
if [[ -e "$HUB_DB" ]]; then
  echo "restore: $HUB_DB already exists; move or delete it by hand before restoring" >&2
  exit 1
fi

mkdir -p "$(dirname "$HUB_DB")" "$LH_DATA_DIR"
sqlite3 "$HUB_DB" < "$SRC/hub/hub.sql"
# Credentials are NOT in the backup: the claude login has to be repeated and auth.json recreated.
rsync -a "$SRC/lh-data"/ "$LH_DATA_DIR"/
echo "restore: database in $HUB_DB and LH data in $LH_DATA_DIR"
echo "restore: now start the services and repeat the logins (docs/RESTORE.md)"
