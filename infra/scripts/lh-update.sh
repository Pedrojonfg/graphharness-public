#!/usr/bin/env bash
# Monthly update of the LH fork. Interactive: pauses where the user must read or test.
# Usage: lh-update.sh [path-to-fork]   (default /opt/lh). The `upstream` remote is already configured.
set -euo pipefail

LH_DIR="${1:-/opt/lh}"
HUB_DIR="${HUB_DIR:-/opt/graphharness}"
cd "$LH_DIR"

pause() { read -r -p "$1 [Enter to continue, Ctrl-C to abort] " _; }

# 1. Fetch new tags from upstream
git fetch upstream --tags
echo "Available tags (the latest):"
git tag --sort=-v:refname | head -5

# 2. The user reads the changelog
pause "Read the changelog of the new tags (https://github.com/ of the upstream)."
read -r -p "Tag to merge (e.g. v0.6.0): " TAG
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "Tag $TAG does not exist" >&2; exit 1; }

# 3. Merge into a branch
git switch -c "update/$TAG"
git merge "$TAG" || { echo "Conflicts: resolve them with PATCHES.md, commit, and run again from step 4." >&2; exit 1; }

# 4. Checks
npm ci && npm run typecheck && npm test && npm run build

# 5. Smoke manual
pause "Manual smoke test on the test instance: create a session, answer a quiz, import a note."

# 6. Hub smoke test (contract tests against a real LH instance with a temporary LH_DATA_DIR)
(cd "$HUB_DIR" && pnpm --filter @graphharness/lh-client test:contract)

# 7. Merge into main and redeploy
pause "All green. Merging into main and restarting lh.service (asks for sudo)."
git switch main
git merge --no-ff "update/$TAG"
sudo systemctl restart lh.service
echo "LH updated to $TAG."
