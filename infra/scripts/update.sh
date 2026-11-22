#!/usr/bin/env bash
# Updates the Hub on the VPS. Usage: sudo bash /opt/graphharness/infra/scripts/update.sh
# SQL migrations are applied automatically when the Hub starts (openDb).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
APP=/opt/graphharness
cd "$APP"

echo "==> git pull"
sudo -u hub git pull --ff-only
echo "==> pnpm install and PWA build"
sudo -u hub bash -c "cd $APP && pnpm install --frozen-lockfile && pnpm build:pwa"
echo "==> uv sync (eval)"
sudo -u hub bash -c "cd $APP/apps/eval && uv sync"
echo "==> systemd units"
install -m 0644 infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
echo "==> restart (migrations run on startup)"
systemctl restart eval.service hub.service hub-worker.service

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4100/api/v1/health; then echo; echo "Hub updated and healthy."; exit 0; fi
  sleep 1
done
echo "The Hub does not respond after the update: journalctl -u hub -n 80" >&2
exit 1
