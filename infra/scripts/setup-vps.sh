#!/usr/bin/env bash
# Prepares an Ubuntu 24.04 ARM64 VPS for LH + Hub.
# Idempotent: it can be re-run. Run as root (sudo) on the VPS; it is NOT run in development.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this script as root (sudo)." >&2
  exit 1
fi

ADMIN_USER="${ADMIN_USER:-ubuntu}"

# --- 1. System packages ------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  build-essential git curl ca-certificates rsync sqlite3 acl \
  texlive-latex-base texlive-latex-recommended texlive-latex-extra texlive-pictures texlive-science lmodern \
  pdf2svg poppler-utils chromium-browser

# --- 2. Node 24 + corepack (pnpm) ---------------------------------------------------
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
corepack enable
corepack prepare pnpm@latest --activate

# --- 3. uv (for apps/eval); installed in /usr/local/bin so systemd can see it -----
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi

# --- 4. Tailscale ---------------------------------------------------------------------
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
echo "Tailscale installed. Connect it by hand the first time: sudo tailscale up"

# --- 5. Users and shared group (D20) -----------------------------------------------
# lh: owner of LH and of /home/lh/materials. hub: owner of the Hub, its `claude` session and the backup.
id lh >/dev/null 2>&1 || useradd --create-home --home-dir /home/lh --shell /bin/bash lh
id hub >/dev/null 2>&1 || useradd --create-home --home-dir /home/hub --shell /bin/bash hub
getent group learn >/dev/null || groupadd learn
for u in lh hub "$ADMIN_USER"; do
  if id "$u" >/dev/null 2>&1; then usermod -aG learn "$u"; else echo "Warning: user $u does not exist; not added to learn." >&2; fi
done

# --- 6. Directories and permissions ------------------------------------------------------------
# /home/lh only contains materials/ (credentials live in /var/lib/lh).
chown lh:learn /home/lh
chmod 0750 /home/lh
install -d -m 2775 -o lh -g learn /home/lh/materials
chmod 2775 /home/lh/materials

install -d -m 0700 -o lh  -g lh  /var/lib/lh /var/lib/lh/data
install -d -m 0700 -o hub -g hub /var/lib/hub /var/lib/hub/reports
install -d -m 0750 -o root -g hub /etc/graphharness
install -d -o hub -g hub /opt/graphharness
install -d -o lh  -g lh  /opt/lh

# --- 7. ACL: hub reads (read-only) /var/lib/lh/data for the backup --------------
# Applied to what exists and as the default ACL for what LH creates later.
# Traversing /var/lib/lh (0700) requires x for hub in that directory only.
setfacl -m u:hub:--x /var/lib/lh
setfacl -R -m u:hub:rX /var/lib/lh/data
setfacl -R -d -m u:hub:rX /var/lib/lh/data
# The credential stays out of hub's reach (auth.json is in /var/lib/lh, without an ACL).

# --- 8. systemd units (not enabled: see docs/DEPLOY.md) ----------------------------------
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../systemd" && pwd)"
install -m 0644 "$SRC"/*.service "$SRC"/*.timer /etc/systemd/system/
systemctl daemon-reload

echo "Setup complete. Next step: docs/DEPLOY.md (clone to /opt, .env, systemctl enable)."
