#!/usr/bin/env bash
# Publishes LH and the Hub on the tailnet with HTTPS. Idempotent; requires sudo on the VPS.
#   https://<host>:443  -> LH  (127.0.0.1:3000)
#   https://<host>:8443 -> Hub (127.0.0.1:4100)  (PWA and REST API)
# /mcp is NOT exposed: the Hub blocks it from the tailnet and the agent uses it over loopback.
set -euo pipefail

tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=8443 http://127.0.0.1:4100
tailscale serve status
