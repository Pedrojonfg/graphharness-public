#!/usr/bin/env bash
# Hub backup to a git repo (D21). Usage: backup.sh <reason>   (e.g. timer, session-close, manual)
# Runs as `hub`. Variables (with the default values):
#   BACKUP_DIR        local backup repo               (/var/lib/hub/backup)
#   HUB_DB            Hub SQLite database             (/var/lib/hub/hub.sqlite)
#   LH_DATA_DIR       LH data (read via ACL)          (/var/lib/lh/data)
#   HUB_REPORTS_DIR   reports                         (/var/lib/hub/reports)
#   BACKUP_REPO       remote to clone if BACKUP_DIR is empty (optional)
#   BACKUP_PUSH       0 = do not push                 (1)
set -euo pipefail

REASON="${1:?usage: backup.sh <reason>}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/hub/backup}"
HUB_DB="${HUB_DB:-/var/lib/hub/hub.sqlite}"
LH_DATA_DIR="${LH_DATA_DIR:-/var/lib/lh/data}"
HUB_REPORTS_DIR="${HUB_REPORTS_DIR:-/var/lib/hub/reports}"
BACKUP_PUSH="${BACKUP_PUSH:-1}"
MAX_BYTES=$((1024 * 1024 * 1024))

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
export HUB_DB

for cmd in sqlite3 rsync git node; do
  command -v "$cmd" >/dev/null || { echo "backup: $cmd is missing from PATH" >&2; exit 1; }
done
[[ -f "$HUB_DB" ]] || { echo "backup: database $HUB_DB does not exist" >&2; exit 1; }

# --- Local repo: clone or initialize the first time ---
if [[ ! -d "$BACKUP_DIR/.git" ]]; then
  if [[ -n "${BACKUP_REPO:-}" ]]; then git clone "$BACKUP_REPO" "$BACKUP_DIR"; else git init -q "$BACKUP_DIR"; fi
fi
mkdir -p "$BACKUP_DIR/hub" "$BACKUP_DIR/lh-data" "$BACKUP_DIR/reports" "$BACKUP_DIR/knowledge"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. Consistent copy of the database and SQL dump (text, diffable) ---
# .dump walks the tables in schema order and the rows by rowid: deterministic output between runs.
sqlite3 "$HUB_DB" ".timeout 5000" ".backup '$TMP/hub.sqlite'"
sqlite3 "$TMP/hub.sqlite" .dump > "$TMP/hub.sql"
mv "$TMP/hub.sql" "$BACKUP_DIR/hub/hub.sql"

# --- 2. LH data, without credentials or debug captures ---
if [[ -d "$LH_DATA_DIR" ]]; then
  rsync -a --delete --delete-excluded --exclude-from="$HERE/backup-exclude.txt" "$LH_DATA_DIR"/ "$BACKUP_DIR/lh-data"/
else
  echo "backup: warning, LH_DATA_DIR ($LH_DATA_DIR) does not exist; lh-data/ is skipped" >&2
fi

# --- 3. Reports: .tex only (the PDFs can be regenerated) ---
if [[ -d "$HUB_REPORTS_DIR" ]]; then
  rsync -a --delete --delete-excluded --prune-empty-dirs --include='*/' --include='*.tex' --exclude='*' \
    "$HUB_REPORTS_DIR"/ "$BACKUP_DIR/reports"/
fi

# --- 4. Readable knowledge base (one Markdown per subject and per concept) ---
node "$REPO_ROOT/apps/hub/src/cli.ts" export-knowledge "$BACKUP_DIR/knowledge"

# --- 5. Commit and push ---
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git -C "$BACKUP_DIR" add -A
if git -C "$BACKUP_DIR" diff --cached --quiet; then
  echo "backup: no changes since the last one"
else
  git -C "$BACKUP_DIR" -c user.name="${GIT_AUTHOR_NAME:-hub-backup}" -c user.email="${GIT_AUTHOR_EMAIL:-hub@localhost}" \
    commit -q -m "backup: $STAMP $REASON"
fi
if [[ "$BACKUP_PUSH" != "0" ]] && git -C "$BACKUP_DIR" remote | grep -q .; then
  git -C "$BACKUP_DIR" push -q
else
  echo "backup: no push (BACKUP_PUSH=0 or no remote configured)"
fi

# --- 6. Repo size (warning in /health) and timestamp ---
BYTES="$(du -sb "$BACKUP_DIR" | cut -f1)"
if (( BYTES > MAX_BYTES )); then
  echo "backup: WARNING the repo takes $BYTES bytes (> 1 GB); check the images in chats/*.json" >&2
fi
sqlite3 "$HUB_DB" ".timeout 5000" \
  "INSERT INTO meta (key, value, updated_at) VALUES ('last_backup_at', '$STAMP', '$STAMP'), ('backup_repo_bytes', '$BYTES', '$STAMP')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;"
echo "backup: ok ($REASON, $BYTES bytes)"
