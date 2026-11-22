#!/usr/bin/env bash
# End-to-end installation on a clean VPS (Ubuntu 24.04 ARM64). Idempotent: it can be re-run.
# Usage: git clone <repo> /opt/graphharness && sudo bash /opt/graphharness/infra/scripts/install.sh
# The repo is PRIVATE: clone it first with a token (https://<token>@github.com/...) or a deploy key.
# Optional variables:
#   GH_REPO            Hub remote              (https://github.com/<you>/graphharness.git)
#   LH_REPO            private fork of LearnHarness (git@github.com:<you>/<lh-fork>.git; needs a deploy key)
#   LH_UPSTREAM_REPO   fallback if there is no fork (https://github.com/amosblomqvist/learnharness.git)
#   LH_UPSTREAM_TAG    fallback tag            (v0.5.0)
#   ADMIN_USER         administrator user     (ubuntu)
#   YES=1              do not ask before irreversible steps
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo bash install.sh" >&2; exit 1; }

GH_REPO="${GH_REPO:-https://github.com/<you>/graphharness.git}"
LH_REPO="${LH_REPO:-git@github.com:<you>/<lh-fork>.git}"
LH_UPSTREAM_REPO="${LH_UPSTREAM_REPO:-https://github.com/amosblomqvist/learnharness.git}"
LH_UPSTREAM_TAG="${LH_UPSTREAM_TAG:-v0.5.0}"
ADMIN_USER="${ADMIN_USER:-ubuntu}"
APP=/opt/graphharness
LH=/opt/lh
ENV_FILE=/etc/graphharness/hub.env
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)"

step() { echo; echo "==> $*"; }
confirm() {
  [[ "${YES:-0}" == "1" ]] && return 0
  # Confirmation answer is 'y' or 'Y'; anything else means no.
  read -r -p "$1 [y/N] " r
  [[ "$r" == "y" || "$r" == "Y" ]]
}

# --- 1. Sistema: usuarios, paquetes, Node, uv, Tailscale, permisos, unidades ---
step "1/8 Preparing the system (setup-vps.sh)"
confirm "Installs packages, creates the lh/hub users and changes permissions. Continue?" || { echo "Cancelled."; exit 1; }
ADMIN_USER="$ADMIN_USER" bash "$HERE/setup-vps.sh"

# --- 2. Hub code in /opt/graphharness (owned by hub) ---
step "2/8 Hub code in $APP"
if [[ ! -d "$APP/.git" ]]; then
  rmdir "$APP" 2>/dev/null || true   # setup-vps.sh creates it empty
  git clone "$SRC" "$APP"
  git -C "$APP" remote set-url origin "$GH_REPO"
fi
chown -R hub:hub "$APP"
if [[ "$SRC" != "$APP" ]]; then echo "Warning: installing from $SRC; updates will use the remote $GH_REPO."; fi

# --- 3. LH in /opt/lh (owned by lh): private fork or, if there is none, upstream ---
step "3/8 LearnHarness in $LH"
if [[ ! -d "$LH/.git" ]]; then
  rmdir "$LH" 2>/dev/null || true
  if sudo -u lh git clone "$LH_REPO" "$LH" 2>/dev/null; then
    echo "Cloned the fork $LH_REPO"
  else
    echo "Could not clone the fork ($LH_REPO): probably the lh user's deploy key is missing."
    confirm "Use upstream $LH_UPSTREAM_REPO at $LH_UPSTREAM_TAG instead?" || { echo "Cancelled: set up the lh deploy key and run again."; exit 1; }
    sudo -u lh git clone --branch "$LH_UPSTREAM_TAG" "$LH_UPSTREAM_REPO" "$LH"
  fi
fi
chown -R lh:lh "$LH"
(cd "$LH" && sudo -u lh npm ci && sudo -u lh npm run build)

# --- 4. Hub, PWA and eval dependencies ---
step "4/8 pnpm install, PWA build and eval uv sync"
sudo -u hub bash -c "cd $APP && pnpm install --frozen-lockfile && pnpm build:pwa"
sudo -u hub bash -c "cd $APP/apps/eval && uv sync"

# --- 5. Configuration and secrets ---
step "5/8 Configuration ($ENV_FILE)"
install -d -m 0750 -o root -g hub /etc/graphharness
if [[ ! -f "$ENV_FILE" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  sed "s/^HUB_MCP_TOKEN=.*/HUB_MCP_TOKEN=$TOKEN/" "$APP/.env.example" > "$ENV_FILE"
  chown root:hub "$ENV_FILE"
  chmod 0640 "$ENV_FILE"   # systemd reads it as root; hub (cli, backup) reads it through the group
  # The same token for the agent (hub-mcp client).
  AGENT_HOME="$(getent passwd "$ADMIN_USER" | cut -d: -f6)"
  install -d -m 0700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$AGENT_HOME/.config/hub-mcp"
  install -m 0600 -o "$ADMIN_USER" -g "$ADMIN_USER" /dev/null "$AGENT_HOME/.config/hub-mcp/token"
  echo "$TOKEN" > "$AGENT_HOME/.config/hub-mcp/token"
  echo "Created $ENV_FILE with a random HUB_MCP_TOKEN and the agent token in $AGENT_HOME/.config/hub-mcp/token"
else
  echo "$ENV_FILE already exists: left untouched."
fi

# --- 6. systemd services ---
step "6/8 systemd services"
install -m 0644 "$APP"/infra/systemd/*.service "$APP"/infra/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now eval.service lh.service hub.service hub-worker.service hub-backup.timer

# LH -> Hub bridge (ADR 104, 105): turns on `hub.enabled` through LH's own API (loopback only). It only
# exists in the fork with the P3a patch; with upstream the route answers 404 and a warning is shown.
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/ && break; sleep 2; done
HUB_PUT="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' -d '{"enabled":true}' http://127.0.0.1:3000/api/settings/hub || true)"
if [[ "$HUB_PUT" == "200" ]]; then
  echo "LH: hub_mastery enabled (settings.hub.enabled = true)."
else
  echo "WARNING: could not enable hub_mastery in LH (HTTP $HUB_PUT). If you installed upstream and not the fork, the P1/P2/P3a patches and the language fragment are missing: the tutor will answer in the material's language and will not see your mastery."
fi

# --- 7. Tailscale serve (if already logged in to the tailnet) ---
step "7/8 Tailscale serve"
if tailscale status >/dev/null 2>&1; then
  bash "$APP/infra/tailscale/serve.sh"
else
  echo "Tailscale is not connected yet: run 'sudo tailscale up' and then 'sudo bash $APP/infra/tailscale/serve.sh'."
fi

# --- 8. Check and manual steps ---
step "8/8 Check"
sleep 3
curl -fsS http://127.0.0.1:4100/api/v1/health >/dev/null && echo "Hub responds at /api/v1/health" || echo "WARNING: the Hub does not respond yet; check 'journalctl -u hub -n 50'."

cat <<MSG

======================================================================
Installation done. MANUAL STEPS that cannot be automated:
  1. sudo tailscale up           (log in via the browser) and then sudo bash $APP/infra/tailscale/serve.sh
  2. sudo -iu lh  claude         (Claude Code login as lh)
     sudo -iu hub claude         (login as hub)
  3. Deploy key for the hub user for the backup repo (BACKUP_REPO in $ENV_FILE):
     sudo -u hub ssh-keygen -t ed25519 -f /home/hub/.ssh/id_ed25519 -N ''   and add the .pub as a deploy key (with write access)
  4. Open LH (https://<vps>.<tailnet>.ts.net/) -> Settings: providers (External CLI = Claude Code),
     models, and fileAccess restricted to /home/lh/materials.
  5. Edit $ENV_FILE (LH_PUBLIC_URL, BACKUP_REPO) and run 'sudo systemctl restart hub hub-worker'.
  6. Connect the agent: see docs/DEPLOY.md (MCP section).
  7. Check the pending-verification list in docs/DEPLOY.md.
======================================================================
MSG
