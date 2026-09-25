#!/usr/bin/env bash
#
# 01-bootstrap.sh — base system for the NEW Biblicana droplet (Ubuntu 24.04).
# Run as root on the new host, once: `bash 01-bootstrap.sh <admin-username>`.
# Touches nothing on the old droplet. Safe to re-run.
#
# Does: updates + unattended security upgrades, 2 GB swap, UFW (SSH allowed
# for now — 03 moves it to the tailnet), fail2ban, the admin sudo user, the
# `biblicana` service user, the `opsread` group, /var/log/biblicana, Redis
# (localhost only), Node 22, pnpm (via corepack) and PM2.
#
# Does NOT: touch SSH settings (05 does that after the admin login is proven),
# install Tailscale (02), or the app (04).
set -euo pipefail

ADMIN=${1:?usage: 01-bootstrap.sh <admin-username>}
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[[ "$VERSION_ID" == "24.04" ]] || { echo "expected Ubuntu 24.04, got $VERSION_ID" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }

step "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get upgrade -yq
apt-get install -yq ufw fail2ban unattended-upgrades redis-server git curl ca-certificates gnupg build-essential python3
# Security updates without anyone logging in. The old host went two years
# without one; never again.
dpkg-reconfigure -f noninteractive unattended-upgrades

step "swap (2 GB, swappiness 10: a safety net, page cache preferred)"
if ! swapon --show | grep -q /swapfile; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-biblicana.conf
sysctl -q --system

step "firewall (public SSH stays open until the tailnet is proven in 02/05)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable

step "fail2ban (sshd jail, defaults)"
systemctl enable --now fail2ban

step "users and groups"
getent group opsread >/dev/null || groupadd --system opsread
if ! id "$ADMIN" &>/dev/null; then
    adduser --disabled-password --gecos "" "$ADMIN"
    usermod -aG sudo "$ADMIN"
    # Passwordless sudo: the account has no password to type (key-only SSH).
    echo "$ADMIN ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-$ADMIN"
    chmod 440 "/etc/sudoers.d/90-$ADMIN"
fi
install -d -m 700 -o "$ADMIN" -g "$ADMIN" "/home/$ADMIN/.ssh"
# Same key root was created with (the DO droplet key).
install -m 600 -o "$ADMIN" -g "$ADMIN" /root/.ssh/authorized_keys "/home/$ADMIN/.ssh/authorized_keys"
# The bot's own account: no password, no SSH key, never logged into directly
# (use `sudo -iu biblicana`). A shell is needed for PM2's startup unit.
id biblicana &>/dev/null || adduser --system --group --home /home/biblicana --shell /bin/bash biblicana

step "log directory: bot writes, opsread group reads"
install -d -m 2750 -o biblicana -g opsread /var/log/biblicana

step "redis (localhost only, as on the old host; cache only, no persistence needed)"
sed -i 's/^#\?\s*bind .*/bind 127.0.0.1 -::1/' /etc/redis/redis.conf
systemctl enable --now redis-server
systemctl restart redis-server
redis-cli ping

step "Node 22 (NodeSource apt repo, signed) + corepack pnpm + PM2"
if ! node -v 2>/dev/null | grep -q '^v22\.'; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -q
    apt-get install -yq nodejs
fi
node -v
corepack enable
npm install -g pm2@latest
pm2 -v

step "checks"
free -m
ufw status verbose | head -8
systemctl is-active fail2ban redis-server
id "$ADMIN"; id biblicana
ls -ld /var/log/biblicana
echo
echo "NEXT: from your Mac, confirm 'ssh $ADMIN@<new-host>' works and 'sudo -n true' succeeds,"
echo "      BEFORE running 05. Then run 02 (Tailscale)."
