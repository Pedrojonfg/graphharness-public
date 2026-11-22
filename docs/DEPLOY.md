# VPS deployment (Oracle ARM64, Ubuntu 24.04)

A guide for deploying on your own. There is no automatic deployment: the VPS is not exposed to the internet (Tailscale only), so GitHub Actions (`.github/workflows/ci.yml`) only runs tests and updates are done by hand with `update.sh`.

## 1. Before you start
- A VPS with Ubuntu 24.04 ARM64 and a user with sudo (`ubuntu`).
- A Tailscale account (your phone and the VPS on the same tailnet).
- If the `graphharness` repo is private, create a read-only GitHub token (fine-grained, Contents: read permission) or a deploy key.
- TikZ figures (ADR 108): TeX with TikZ and **`poppler-utils`** (`pdftocairo` produces the SVG); `install.sh` installs them via `setup-vps.sh`. In `/etc/graphharness/hub.env`, **`HUB_FIGURES_DIR`** (default `/var/lib/hub/figures`) is where the Hub stores the compiled PDF/SVG.

## 2. Install
```bash
sudo git clone https://<TOKEN>@github.com/<owner>/graphharness.git /opt/graphharness
# Remove the token from .git/config (otherwise it stays on the VPS in clear text):
sudo git -C /opt/graphharness remote set-url origin https://github.com/<owner>/graphharness.git
sudo bash /opt/graphharness/infra/scripts/install.sh
```
For `update.sh` you will need access to the private repo again: the most convenient option is a read-only deploy key (`git remote set-url origin git@github.com:<owner>/graphharness.git`).

**Materials:** each subject has its own folder at `/home/lh/materials/<subject-folder>/` (ADR 103). By default the folder is the subject's slug. That is where the agent downloads PDFs, and where it saves its class notes (`<folder>/agent-notes/`).
`install.sh` is idempotent and asks before anything irreversible (`YES=1` to skip the questions). It does: users and permissions (`setup-vps.sh`), packages, Node 24, pnpm, uv, Tailscale; clones LH into `/opt/lh` (a private fork of LearnHarness if the `lh` deploy key exists; otherwise it offers upstream `v0.5.0`); `pnpm install`; builds the PWA; `uv sync` for eval; creates `/etc/graphharness/hub.env` with a random `HUB_MCP_TOKEN` and the agent token in `~ubuntu/.config/hub-mcp/token`; installs and starts the services (`eval`, `lh`, `hub`, `hub-worker`, `hub-backup.timer`) and runs `tailscale serve` if you are already connected.

At the end it prints the manual steps. In order:
1. `sudo tailscale up` (browser login) and `sudo bash /opt/graphharness/infra/tailscale/serve.sh` (443 → LH, 8443 → Hub; `/mcp` is not exposed).
2. Claude Code login **once per user**: `sudo -iu lh claude` and `sudo -iu hub claude`.
3. Deploy key for `hub` on the backup repo: `sudo -u hub ssh-keygen -t ed25519 -N '' -f /home/hub/.ssh/id_ed25519`, add the `.pub` as a deploy key **with write access** and set `BACKUP_REPO` in `/etc/graphharness/hub.env`.
4. In LH (`https://<vps>.<tailnet>.ts.net/` → Settings): External CLI provider = Claude Code, models, and `fileAccess` restricted to `/home/lh/materials`.
   `install.sh` already turns on the bridge to the Hub (`PUT /api/settings/hub {"enabled": true}`, ADR 104) and `lh.service` sets `LH_HUB_URL`. That setting and the language fragment (Spanish, ADR 105) only exist in the **fork**; if you installed upstream, the script warns you and LH will answer in the language of the material without seeing your domain.
5. Edit `/etc/graphharness/hub.env` (`LH_PUBLIC_URL`, etc.) and run `sudo systemctl restart hub hub-worker`.

Check: `curl -s http://127.0.0.1:4100/api/v1/health` and open `https://<vps>.<tailnet>.ts.net:8443/` (see PWA in the README).

## 3. Connect the agent over MCP
The token is in `~/.config/hub-mcp/token` (0600) of the agent's user.
- **stdio (recommended)**: the agent launches the `hub-mcp` binary (`/opt/graphharness/apps/mcp-stdio/src/bin.ts`, runnable with Node 24). Example configuration:
  ```json
  { "mcpServers": { "hub": { "command": "node", "args": ["/opt/graphharness/apps/mcp-stdio/src/bin.ts"] } } }
  ```
  Variables: `HUB_MCP_URL` (default `http://127.0.0.1:4100/mcp`) and `HUB_MCP_TOKEN_FILE`.
- **Direct HTTP**: an MCP client with URL `http://127.0.0.1:4100/mcp` and the header `Authorization: Bearer <token>`. `/mcp` only answers on loopback.
- **Rotate the token**: `sudo -u hub node /opt/graphharness/apps/hub/src/cli.ts rotate-mcp-token --env-file /etc/graphharness/hub.env --token-file ~/.config/hub-mcp/token` (both files end up 0600) and `sudo systemctl restart hub`.

## 4. Update
- **Hub**: `sudo bash /opt/graphharness/infra/scripts/update.sh` (git pull, pnpm install, PWA build, uv sync, restart with migrations, `/health` check).
- **LH (monthly)**: `bash /opt/graphharness/infra/scripts/lh-update.sh`. It is interactive: it pauses so you can read the changelog and run the manual smoke test (create a session, answer a quiz, import a note).

## 5. Backups and restore
`hub-backup.timer` runs `infra/scripts/backup.sh` every day at 03:30 (Europe/Madrid); it also runs when a session is closed. It pushes to the backup repo: the Hub SQL dump, LH data **without credentials**, the `.tex` of reports and a readable Markdown export. Manual run: `sudo -u hub bash -c 'set -a; . /etc/graphharness/hub.env; /opt/graphharness/infra/scripts/backup.sh manual'`. Restore: [RESTORE.md](RESTORE.md).

## 6. Common problems
| Symptom | What to check |
|---|---|
| `install.sh` does not clone the LH fork | The `lh` deploy key is missing (`sudo -u lh ssh -T git@github.com`); accept upstream, or set it up and re-run |
| LH reachable from outside loopback | `ss -ltnp \| grep 3000` must show `127.0.0.1:3000`. `next start` ignores `HOSTNAME`; `lh.service` uses `-H 127.0.0.1` and LH has no authentication |
| Hub does not start | `journalctl -u hub -n 80`; usually a malformed `hub.env` or port 4100 already in use |
| `/mcp` rejects the agent | Different token in `hub.env` and in `~/.config/hub-mcp/token`: rotate it again and restart `hub` |
| The PWA does not load on :8443 | `tailscale serve status`; re-run `infra/tailscale/serve.sh`; check that `apps/pwa/dist` exists (`pnpm build:pwa`) |
| LLM fails in the Hub | The `claude` login must be done as **hub** (`sudo -iu hub claude`) |
| Backup without push | Deploy key without write access or empty `BACKUP_REPO`; `journalctl -u hub-backup -n 50` |
| Backup cannot see LH data | ACL of `hub` on `/var/lib/lh/data`: `getfacl /var/lib/lh/data` (applied by `setup-vps.sh`) |
| `better-sqlite3` does not load | A Node other than 24 in the service: `node -v` and `pnpm rebuild better-sqlite3` |
| The backup repo exceeds 1 GB | Images in `chats/*.json`; `/health` warns about it |
| Demos always fail ("No render engine available") or the teacher does not offer `demo` | LH cannot find Chrome. Install one that is not a snap (e.g. `sudo -iu lh npx playwright install chromium`, which LH detects on its own in `~/.cache/ms-playwright`) or set the path: `sudo systemctl edit lh` with `[Service]` and `Environment=CHROME_PATH=/path/to/chrome`, and restart `lh`. Locally, export `CHROME_PATH` or install Playwright's Chromium |

## 7. Verify on the first deployment (F0)
Record the results in `docs/F0-REPORT.md`.
- [ ] LH's subscription connection flow works without Electron (`app/api/subscriptions/browser`).
- [ ] Chromium on Ubuntu 24.04 ARM64 for the interactive demos (the snap package usually fails under systemd: use Playwright's or set `CHROME_PATH`, see section 6). Without a browser, LH no longer offers `demo` to the teacher.
- [ ] Native dependencies on ARM64: `@resvg/resvg-js`, `@silvia-odwyer/photon-node`, `pdfjs-dist` (`npm test` in `/opt/lh`).
- [ ] Restricted `fileAccess`: a path outside `/home/lh/materials` is rejected.
- [ ] Two Claude Code logins (lh and hub) of the same account are allowed at the same time.
- [ ] The read-only ACL of `hub` on `/var/lib/lh/data` allows the backup.
- [ ] Usage policy for automated `claude -p` with a subscription.
- [ ] Location of the result carrying the student's answer in LH's `toolResult` (already covered by `lh-client` fixtures).
- [ ] Even better, `pnpm --filter @graphharness/lh-client test:contract` against a real LH instance.
