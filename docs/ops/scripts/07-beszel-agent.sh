#!/usr/bin/env bash
#
# 07-beszel-agent.sh — metrics for the lionmark-ops Beszel hub. Run as root on
# the new host:
#   BESZELKEY='ssh-ed25519 AAAA...' bash 07-beszel-agent.sh [version]
# BESZELKEY: the hub's public key, shown in Beszel's "Add system" dialog.
# version: a release tag from github.com/henrygd/beszel/releases (pin one;
# default below was current when this was written — check before running).
#
# Listens on the TAILNET address only, :45876. ~10 MB RSS, which is why Beszel
# and not Netdata (ops-platform docs/architecture.md).
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
: "${BESZELKEY:?set BESZELKEY to the hub public key}"
VER=${1:?pass a release tag, e.g. v0.12.10 — check github.com/henrygd/beszel/releases}
TSIP=$(tailscale ip -4)
[[ -n "$TSIP" ]] || { echo "no tailnet IP; run 02 first" >&2; exit 1; }

id beszel &>/dev/null || adduser --system --group --no-create-home beszel

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/agent.tgz" \
    "https://github.com/henrygd/beszel/releases/download/${VER}/beszel-agent_linux_amd64.tar.gz"
tar -xzf "$TMP/agent.tgz" -C "$TMP" beszel-agent
install -m 0755 -o root -g root "$TMP/beszel-agent" /usr/local/bin/beszel-agent

install -d -m 0750 -o root -g beszel /etc/beszel
printf 'LISTEN=%s:45876\nKEY="%s"\n' "$TSIP" "$BESZELKEY" > /etc/beszel/agent.env
chmod 0640 /etc/beszel/agent.env

cat > /etc/systemd/system/beszel-agent.service <<'EOF'
[Unit]
Description=Beszel agent (metrics for lionmark-ops)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
User=beszel
Group=beszel
EnvironmentFile=/etc/beszel/agent.env
ExecStart=/usr/local/bin/beszel-agent
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
MemoryMax=64M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now beszel-agent
sleep 2
systemctl is-active beszel-agent
ss -tlnp | grep 45876
echo "Must be bound to $TSIP only (not 0.0.0.0). Then add the system in the Beszel hub."
