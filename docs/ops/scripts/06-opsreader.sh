#!/usr/bin/env bash
#
# 06-opsreader.sh — the lionmark-ops agents' read-only door. Run as root on
# the new host, from a checkout that has ops-platform beside it:
#   OPSKEY='ssh-ed25519 AAAA... opsreader@lionmark-ops' OPSFROM=100.x.y.z \
#       bash 06-opsreader.sh /path/to/ops-platform
# OPSKEY: the opsreader PUBLIC key from lionmark-ops (secrets/ssh/ there).
# OPSFROM: lionmark-ops' tailnet IP; the key works from nowhere else.
#
# The key can run exactly one program, opsreader-gate, which accepts five fixed
# verbs (health, procs, units, journal, logtail) and parses everything else as
# data. See ops-platform docs/security.md.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
OPS=${1:?usage: 06-opsreader.sh /path/to/ops-platform}
: "${OPSKEY:?set OPSKEY to the opsreader public key}"
: "${OPSFROM:?set OPSFROM to the lionmark-ops tailnet IP}"
[[ -f "$OPS/remote/opsreader-gate.sh" ]] || { echo "no $OPS/remote/opsreader-gate.sh" >&2; exit 1; }
[[ "$OPSKEY" =~ ^ssh-(ed25519|rsa)\  ]] || { echo "OPSKEY doesn't look like a public key" >&2; exit 1; }

# No password, no sudo, in opsread (which can read /var/log/biblicana).
# A real shell is required: sshd runs the forced command through it.
id opsreader &>/dev/null || adduser --disabled-password --gecos "" --shell /bin/sh opsreader
usermod -aG opsread opsreader
# Without systemd-journal, journalctl as a plain user prints a permissions hint
# and NO entries — exit status 0 — so the gate's `journal` verb would report
# "nothing happened" for a unit that restarted all night. The gate still limits
# which units can be read; the group only makes the answer truthful.
usermod -aG systemd-journal opsreader
passwd -l opsreader >/dev/null

install -m 0755 -o root -g root "$OPS/remote/opsreader-gate.sh" /usr/local/bin/opsreader-gate
install -d -m 0755 -o root -g root /etc/opsreader
cat > /etc/opsreader/gate.conf <<'EOF'
# /etc/opsreader/gate.conf on the Biblicana host. Sourced by bash; keep it to
# these two assignments. Written by biblicana docs/ops/scripts/06-opsreader.sh.
UNITS=(pm2-biblicana redis-server)
declare -A LOGS=(
  [out]=/var/log/biblicana/index-out.log
  [err]=/var/log/biblicana/index-error.log
)
EOF
chown root:root /etc/opsreader/gate.conf
chmod 0644 /etc/opsreader/gate.conf

install -d -m 700 -o opsreader -g opsreader /home/opsreader/.ssh
printf 'restrict,from="%s",command="/usr/local/bin/opsreader-gate" %s\n' "$OPSFROM" "$OPSKEY" \
    > /home/opsreader/.ssh/authorized_keys
chown opsreader:opsreader /home/opsreader/.ssh/authorized_keys
chmod 600 /home/opsreader/.ssh/authorized_keys

echo "-- local gate test (as opsreader, simulating the forced command):"
for cmd in help health procs units "logtail out 5" "logtail err 5" "journal pm2-biblicana 1h now"; do
    printf '\n$ %s\n' "$cmd"
    sudo -u opsreader env SSH_ORIGINAL_COMMAND="$cmd" /usr/local/bin/opsreader-gate 2>&1 | head -6 || true
done
echo
echo "-- journal must return entries, not a permissions hint:"
if sudo -u opsreader env SSH_ORIGINAL_COMMAND="journal pm2-biblicana 7d now" /usr/local/bin/opsreader-gate 2>&1 | grep -qi 'insufficient permissions\|not seeing messages'; then
    echo "journal is unreadable for opsreader — STOP"; exit 1
fi
echo "ok"
echo
echo "-- must be REJECTED:"
for cmd in "cat /srv/biblicana/.env" "logtail /etc/shadow" "journal sshd 1h now" "health; id"; do
    printf '$ %s -> ' "$cmd"
    if sudo -u opsreader env SSH_ORIGINAL_COMMAND="$cmd" /usr/local/bin/opsreader-gate >/dev/null 2>&1; then
        echo "ACCEPTED — STOP, the gate is not working"; exit 1
    else
        echo "rejected"
    fi
done
echo
echo "NEXT: from lionmark-ops: ssh -i <opsreader key> opsreader@biblicana health"
