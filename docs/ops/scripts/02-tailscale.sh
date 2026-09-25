#!/usr/bin/env bash
#
# 02-tailscale.sh — join the tailnet as tag:prod. Run as root on the new host:
#   TSAUTHKEY=tskey-auth-... bash 02-tailscale.sh
# Get a one-off, pre-tagged (tag:prod) auth key from the Tailscale admin
# console > Settings > Keys. Pass it in the environment, never on a command
# line that lands in shell history, and do not save it anywhere.
#
# Public SSH stays open after this. It closes only in 05, after SSH over the
# tailnet has been proven from your Mac.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
: "${TSAUTHKEY:?set TSAUTHKEY to a tag:prod auth key}"

if ! command -v tailscale >/dev/null; then
    # Tailscale's own installer: adds their signed apt repo for this release.
    curl -fsSL https://tailscale.com/install.sh | sh
fi
tailscale up --authkey="$TSAUTHKEY" --advertise-tags=tag:prod --hostname=biblicana
unset TSAUTHKEY

# Allow SSH (and later the Beszel agent) on the tailnet interface.
ufw allow in on tailscale0 to any port 22 proto tcp
ufw allow in on tailscale0 to any port 45876 proto tcp

tailscale status | head -5
echo
echo "Tailnet IP: $(tailscale ip -4)"
echo "NEXT: from your Mac (on the tailnet): ssh <admin>@biblicana   — must work before 05."
