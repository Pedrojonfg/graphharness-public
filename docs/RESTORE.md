# Restoring from backup

The backup is a private git repo (the backup repo) containing: `hub/hub.sql` (SQL dump of the Hub database), `lh-data/` (LH data without credentials), `reports/` (`.tex` files only) and `knowledge/` (readable Markdown; it is not restored, it is regenerated).

Credentials (`auth.json`, `*-credentials.json`) are **not in the backup**: after restoring you must log in again.

## Steps (new VPS)

1. Prepare the server: `sudo infra/scripts/setup-vps.sh`, and clone `graphharness` and the LH fork into `/opt` (see `DEPLOY.md`). The services must be stopped.
2. Clone the backup (needs the deploy key of the `hub` user):
   ```bash
   sudo -u hub git clone git@github.com:<owner>/<backup-repo>.git /var/lib/hub/backup
   ```
3. Restore the database and the LH data:
   ```bash
   sudo -u hub /opt/graphharness/infra/scripts/restore.sh /var/lib/hub/backup /var/lib/hub/hub.sqlite /tmp/lh-restore
   sudo rsync -a /tmp/lh-restore/ /var/lib/lh/data/ && sudo chown -R lh:lh /var/lib/lh/data
   ```
   This is equivalent to `sqlite3 hub.sqlite < hub.sql` plus copying `lh-data/` to `LH_DATA_DIR`. The script refuses to overwrite an existing database.
4. Reports (optional): copy `reports/*.tex` to `/var/lib/hub/reports/`; the PDFs are regenerated.
5. Recreate secrets: `/etc/graphharness/hub.env`, `LH_AUTH_FILE` (keys in LH Settings), the `claude` login as `lh` and as `hub`, and a new MCP token (`node apps/hub/src/cli.ts rotate-mcp-token`).
6. Start: `sudo systemctl start lh hub hub-worker eval`.
7. Check: `curl -s http://127.0.0.1:4100/api/v1/health` and open the PWA.

## Test

`apps/hub/test/infra/infra.test.ts` restores a backup into a temporary folder and checks that the database reproduces the same `GET /subjects/:id/map` (the F1 restore test).
