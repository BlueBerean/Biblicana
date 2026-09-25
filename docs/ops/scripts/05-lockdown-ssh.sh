#!/usr/bin/env bash
#
# 05-lockdown-ssh.sh — close the doors. Run as root on the new host ONLY after
# both of these work from your Mac, in a terminal you keep open:
#   ssh <admin>@biblicana        (over the tailnet)
#   sudo -n true                 (in that session)
# Usage: bash 05-lockdown-ssh.sh
#
# Then, separately, in the DigitalOcean console: attach a cloud firewall to
# this droplet with NO inbound rules (Tailscale needs none: it connects out).
# UFW alone isn't enough to rely on; the DO firewall sits outside the droplet.
#
# Rollback: DO console > droplet > Access > Recovery Console (works without
# SSH), then remove /etc/ssh/sshd_config.d/00-biblicana.conf and
# `ufw allow OpenSSH`.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
tailscale status >/dev/null || { echo "tailscale is not up; refusing" >&2; exit 1; }

# 00- so it is read FIRST: sshd keeps the first value it sees for each
# setting. On the old host 50-cloud-init.conf's "PasswordAuthentication yes"
# silently beat 60-cloudimg-settings.conf's "no". A 00- file wins over both.
cat > /etc/ssh/sshd_config.d/00-biblicana.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh

# Public SSH closed; tailnet SSH (allowed in 02) stays.
ufw delete allow OpenSSH || true
ufw status verbose | head -12

echo "-- effective (must read: no / no / yes):"
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication) '
echo
echo "NOW: open a NEW terminal and 'ssh <admin>@biblicana' before closing this one."
