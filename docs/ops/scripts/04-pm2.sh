#!/usr/bin/env bash
#
# 04-pm2.sh — PM2 under the `biblicana` user, started at boot by systemd, with
# log rotation. Run as root on the new host AFTER data/ and .env are in place:
#   bash 04-pm2.sh
#
# Starts the bot. With the TEST bot's credentials in .env this is the smoke
# test (runbook step 6); with prod's it is the cutover (step 7). Never run the
# prod token on two hosts at once.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
APP=/srv/biblicana

[[ -f $APP/.env ]] || { echo "missing $APP/.env (runbook step 5)" >&2; exit 1; }
[[ "$(stat -c '%U %a' $APP/.env)" == "biblicana 600" ]] || { echo ".env must be biblicana:600" >&2; exit 1; }
grep -q '^NODE_ENV=production' $APP/.env || echo "WARNING: NODE_ENV=production is not in .env — Sentry will say development and the heartbeat will not start." >&2
grep -q '^SENTRYDSN=' $APP/.env || echo "WARNING: no SENTRYDSN in .env — Sentry and the heartbeat are off." >&2

sudo -iu biblicana bash -euo pipefail <<EOF
cd "$APP"
pm2 start ecosystem.config.cjs
pm2 save
# pm2-logrotate as on the old host: daily, 10 MB cap, 7 kept, compressed.
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
EOF

# The unit the old host never had: PM2 comes back after a reboot.
env PATH="$PATH:/usr/bin" pm2 startup systemd -u biblicana --hp /home/biblicana
systemctl enable pm2-biblicana
systemctl is-enabled pm2-biblicana

# Hand the running daemon to systemd NOW. The daemon started above runs
# outside the unit, so until a reboot `systemctl is-active pm2-biblicana`
# (the ops gate's `units` verb) would report a healthy bot as inactive. The
# unit's ExecStart is `pm2 resurrect`, which restarts what `pm2 save` stored:
# a few seconds' restart, then systemd owns it.
sudo -iu biblicana pm2 save
sudo -iu biblicana pm2 kill
systemctl start pm2-biblicana
systemctl is-active pm2-biblicana

sleep 15
echo "-- startup lines:"
grep -E '\[Sentry\]|\[Heartbeat\]|Logged in as|Database ERR' /var/log/biblicana/index-out.log /var/log/biblicana/index-error.log | tail -8
sudo -iu biblicana pm2 list
