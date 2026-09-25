# Host migration, September 2026

Move Biblicana from the current droplet to a **new 2 GB Ubuntu 24.04 droplet**, and in the same move: Node 22 (required by Sentry), the bot off root, PM2 started at boot, timestamped logs, tailnet-only SSH, the ops `opsreader` door, and Beszel.

**Why a new droplet, not in-place hardening** (decided with Kenneth, 2026-09-25): the current host runs **Ubuntu 23.10, out of support since July 2024**, with 886 days' uptime and `reboot-required` set. Every step below is easier on a clean machine, and **the old droplet is the rollback**: it stays intact, with the bot stopped, until the new one has run a week.

**Status: prepared, not run.** Scripts in `docs/ops/scripts/` are syntax- and ShellCheck-clean but have not executed on a real host. Kenneth runs each step, or says "go" for that step.

## Before you start

- **Cost:** new droplet `s-1vcpu-2gb` $12/mo, run alongside the old $6/mo one for about a week, then the old one is snapshotted and destroyed.
- **Downtime:** only at cutover (step 7), about a minute: stop old, start new.
- **You need:** DigitalOcean console access; a Tailscale auth key tagged `tag:prod`; `SENTRYDSN` (Sentry > biblicana > Settings > Client Keys); about 90 minutes for steps 1-6, then 10 for the cutover.
- **Never run the prod bot token on two hosts at once.** Both would answer every event in ~570 servers. The smoke test (step 6) uses the test bot's token.
- **Stop your local dev bot during step 6**: it uses the same test token.

## Run order

| # | Step | Where | Prod impact |
|---|---|---|---|
| 1 | Create the droplet | DO console | none |
| 2 | `01-bootstrap.sh` | new host, root | none |
| 3 | `02-tailscale.sh`, then `05-lockdown-ssh.sh` | new host | none |
| 4 | `03-app-install.sh`, copy `data/` | new host, your Mac | none |
| 5 | `.env` files | new host | none |
| 6 | Smoke test with the TEST bot: `04-pm2.sh`, reboot test | new host | none |
| 7 | **Cutover** | both | ~1 min down |
| 8 | `06-opsreader.sh`, `07-beszel-agent.sh`, DO cloud firewall and alerts | new host, DO console | none |
| 9 | Swap the docs (Appendix A) | repo, memory | none |
| 10 | After 7 stable days: snapshot and destroy the old droplet | DO console | none |

---

### 1. Create the droplet

DO console > Create > Droplet: **Ubuntu 24.04 LTS**, NYC3 (same region as the old one and near Neon's `us-east-1`), **Basic, Regular, `s-1vcpu-2gb`**, your existing SSH key, **Monitoring enabled** (installs `do-agent`), hostname `biblicana-bot-prod-2`, tag `biblicana`.

- **Check:** `ssh root@<new public IP>` works.
- **Rollback:** destroy it.

### 2. Bootstrap

```bash
scp docs/ops/scripts/*.sh root@<new public IP>:/root/
ssh root@<new public IP> 'bash /root/01-bootstrap.sh kenneth'
```

Base packages, unattended security upgrades, 2 GB swap (`swappiness=10`), UFW (public SSH still allowed), fail2ban, admin user `kenneth` (your key, passwordless sudo), service user `biblicana`, group `opsread`, `/var/log/biblicana`, Redis on localhost, Node 22, corepack, PM2.

- **Check:** in a second terminal, `ssh kenneth@<new public IP>` then `sudo -n true && echo ok`. The script prints Node 22, `active` for fail2ban and Redis, and both users.
- **Rollback:** destroy and recreate the droplet (nothing depends on it yet).

### 3. Tailnet, then close public SSH

```bash
ssh root@<new public IP>
TSAUTHKEY=tskey-auth-... bash /root/02-tailscale.sh        # key tagged tag:prod
```

- **Check, from your Mac on the tailnet:** `ssh kenneth@biblicana` works. **Do not continue until it does.**

Then, with that tailnet session open:

```bash
sudo bash /root/05-lockdown-ssh.sh
```

It sets `PermitRootLogin no` and `PasswordAuthentication no` in a `00-` file (sshd keeps the FIRST value it reads; on the old host a `50-` file silently turned passwords back on), and removes public SSH from UFW.

- **Check:** a **new** terminal: `ssh kenneth@biblicana` works; `ssh root@<public IP>` fails.
- **Rollback:** DO console > droplet > Access > **Recovery Console** (no SSH needed): delete `/etc/ssh/sshd_config.d/00-biblicana.conf`, `ufw allow OpenSSH`, `systemctl reload ssh`.

From here on, reach the host as `kenneth@biblicana` and use `sudo`.

### 4. App and data

```bash
ssh kenneth@biblicana 'sudo bash /root/03-app-install.sh refactor'
```

Clones to `/srv/biblicana` as `biblicana`, installs with pnpm from the **tracked** lockfile (the old host used npm with an untracked, stale `package-lock.json`), and checks `sqlite3` and the profiler load on Node 22. The ignored-build-script warning for `@sentry/node-cpu-profiler` is expected: it ships prebuilt binaries.

**Data (~710 MB, 13 files), copied from prod's own copy.** No pipes on `scp`/`rsync`: a pipe can truncate a transfer silently with a clean exit, and a half-copied SQLite passes early reads and fails hours later (`CLAUDE.md`).

```bash
# on your Mac
mkdir -p ~/biblicana-data-transfer
rsync -a --progress root@<OLD public IP>:/root/dev/biblicana/data/ ~/biblicana-data-transfer/
rsync -a --progress ~/biblicana-data-transfer/ kenneth@biblicana:/tmp/biblicana-data/
ssh kenneth@biblicana 'sudo rsync -a /tmp/biblicana-data/ /srv/biblicana/data/ && sudo chown -R biblicana:biblicana /srv/biblicana/data && rm -rf /tmp/biblicana-data'
```

- **Check: checksums match on both ends,** not just the exit code:
  ```bash
  ssh root@<OLD public IP> 'cd /root/dev/biblicana/data && md5sum * | sort -k2' > /tmp/md5-old.txt
  ssh kenneth@biblicana 'cd /srv/biblicana/data && sudo md5sum * | sort -k2' > /tmp/md5-new.txt
  diff /tmp/md5-old.txt /tmp/md5-new.txt && echo "data identical"
  ```
- Then run the tests on the new host (they read `bible.db`): `ssh kenneth@biblicana 'sudo -iu biblicana bash -c "cd /srv/biblicana && node --test tests/*.test.js 2>&1 | tail -8"'`. Expect 358/358.
- **Rollback:** nothing to undo; the old host is untouched.

### 5. `.env` files

Two files, both `biblicana:600`. They carry secrets: copy host to host, never into the repo.

**Prod** (used at cutover), copied from the old host without landing on your Mac's disk:

```bash
scp -3 root@<OLD public IP>:/root/dev/biblicana/.env kenneth@biblicana:/tmp/env.prod
ssh kenneth@biblicana 'sudo install -m 600 -o biblicana -g biblicana /tmp/env.prod /srv/biblicana/.env.prod && rm /tmp/env.prod'
```

Then edit `/srv/biblicana/.env.prod` (`sudo -u biblicana nano …`) and add:

```
NODE_ENV=production
SENTRYDSN=<from Sentry>
```

Leave out `SENTRYTRACESRATE` (the default of 100% is right for this traffic). Also check `EMBEDFOOTERTEXT` shows the version being deployed, and that `DISABLE_RATE_LIMITS` and `DEBUG_AICHAT_RAG` are **absent**. The old host's `.env.bak-*` and `.env.save` files are not copied.

**Smoke** (used in step 6): your **local** `.env` (test bot, Neon `dev-local`) with these changes: **delete** `DISABLE_RATE_LIMITS`, `DEBUG_AICHAT_RAG` and `SENTRYTRACESRATE`, and **add** `SENTRYENVIRONMENT=staging`. Staging keeps the smoke run out of prod's Sentry numbers, and the heartbeat stays off. Install it as `/srv/biblicana/.env` the same way.

- **Check:** `sudo ls -l /srv/biblicana/.env*` shows `-rw------- biblicana`.

### 6. Smoke test with the test bot

Stop your local dev bot first.

```bash
ssh kenneth@biblicana 'sudo bash /root/04-pm2.sh'
```

It starts PM2 as `biblicana` from `ecosystem.config.cjs` (the `--import` flag, timestamps, log paths, 400 MB limit, all in git), installs `pm2-logrotate`, creates and starts the **`pm2-biblicana`** systemd unit, and prints the startup lines. Expect `[Sentry] Enabled — environment=staging`, `[Heartbeat] Off in environment "staging"`, `Logged in as Biblicana#6575`, and no `Database ERR`. The script warns that `NODE_ENV=production` is missing; that's expected for the smoke file.

- **Check in Discord (Sola Lab):** `/bible john 3:16`, a button, an AI mention. In Sentry, the traces appear under environment `staging`.
- **Check the logs have timestamps:** `sudo tail -3 /var/log/biblicana/index-out.log` shows each line starting with a date.
- **Reboot test** (the old host never had one): `sudo reboot`, wait a minute, then `ssh kenneth@biblicana 'systemctl is-active pm2-biblicana; sudo -iu biblicana pm2 list'`. It must come back `active` with `index` online, with nobody touching it.
- **Rollback:** `sudo systemctl stop pm2-biblicana`.

### 7. Cutover (~1 minute of downtime)

```bash
# new host: stop the smoke run, switch to prod's .env
ssh kenneth@biblicana 'sudo -iu biblicana pm2 stop index && sudo -u biblicana cp /srv/biblicana/.env.prod /srv/biblicana/.env'

# old host: stop the bot (keep everything else as is — it is the rollback)
ssh root@<OLD public IP> 'pm2 stop index && pm2 save'

# new host: start it with prod's .env
ssh kenneth@biblicana 'sudo -iu biblicana pm2 restart index && sudo -iu biblicana pm2 save'
```

**Verify, in this order:**
1. `ssh kenneth@biblicana 'sudo grep -E "\[Sentry\]|\[Heartbeat\]|Logged in as|Database ERR" /var/log/biblicana/index-*.log | tail -6'` shows `[Sentry] Enabled — environment=production`, `[Heartbeat] Started — Sentry monitor "biblicana-gateway"`, and the prod bot's login line. **`environment=development` or `Heartbeat] Off` here means `NODE_ENV` is wrong: fix it before going on.**
2. A real `/bible` in a server you're in, not the test server.
3. Within ~10 minutes: Sentry > Crons shows **`biblicana-gateway`** with an OK check-in in `production`. The monitor didn't exist before this, so its appearance proves the heartbeat.
4. Within 30 minutes: `[TopGG] Posted server_count=5xx` in the out-log.

**Rollback (any time while the old droplet exists):**
```bash
ssh kenneth@biblicana 'sudo -iu biblicana pm2 stop index'
ssh root@<OLD public IP> 'pm2 start index'
```
Settings live in Neon and are shared, so nothing diverges; each host's Redis is only a cache. The heartbeat monitor will alert once while the new host is silent. That's expected; resolve it after rolling back.

### 8. Ops access, metrics, cloud firewall, alerts

- `06-opsreader.sh` (needs the `opsreader` public key and lionmark-ops' tailnet IP from ops-platform). It installs the gate and `gate.conf` (`UNITS=(pm2-biblicana redis-server)`, the two log files), and **tests every verb, that `journal` returns real entries, and that four non-verbs are rejected**. It exits non-zero if any rejection fails.
- `07-beszel-agent.sh <release tag>` with the hub's key. It binds to the tailnet IP only; the script prints `ss` output to confirm.
- **DO cloud firewall** on this droplet: **no inbound rules** (Tailscale connects outward). UFW is inside the droplet; the DO firewall is outside it.
- **DO alert policies** (none could be confirmed on the old host): memory above 90% for 5 min, disk above 80%, CPU above 90% for 10 min, emailing you. These fire even if lionmark-ops is down.

### 9. Swap the docs

Apply Appendix A. The old deploy commands (`root@<old IP>`, `/root/dev/biblicana`, `npm ci`) are wrong from step 7 on.

### 10. Decommission the old droplet (after 7 stable days)

DO console: take a **snapshot** of `biblicana-bot-prod` (a cheap safety net), then **destroy** the droplet. The snapshot can be deleted after a further month.

---

## Appendix A — docs to swap in after cutover

**`CLAUDE.md` > "Deploying to prod"** becomes:

```
Prod lives on droplet `biblicana-bot-prod-2`, reached over the tailnet as
`biblicana` (no public SSH, no root login). Deployment flow:
1. Push changes to `BlueBerean/Biblicana` on GitHub
2. `ssh kenneth@biblicana`
3. `sudo -iu biblicana bash -c 'cd /srv/biblicana && git pull --ff-only'`
4. If `pnpm-lock.yaml` changed: `sudo -iu biblicana bash -c 'cd /srv/biblicana && pnpm install --frozen-lockfile'`
5. `sudo -iu biblicana pm2 restart index`
6. `sudo tail -30 /var/log/biblicana/index-out.log` — timestamps on every line;
   expect `[Sentry] Enabled — environment=production` and `[Heartbeat] Started`
```

and in the release checklist, item 2's `.env` path becomes `/srv/biblicana/.env` (edit as `biblicana`), and item 5's "Node 18.13's TAP lexer" note becomes history.

**`CLAUDE.md` > Tech stack**: runtime "Node.js 22 in prod and dev"; package manager "pnpm everywhere (prod since the 2026-09 migration)"; drop the "must NOT be pulled onto 18.13" warning. **Known pitfalls**: replace the Node-mismatch and droplet-capacity items with the 2 GB figures (re-measure with `free -m` first).

**Claude memory `reference_droplet_deploy`** (Claude updates this itself): host `kenneth@biblicana` over the tailnet, path `/srv/biblicana`, PM2 as `biblicana` under unit `pm2-biblicana`, logs in `/var/log/biblicana/`, install with pnpm. **`project_droplet_capacity`**: add the new size and the date.

**ops-platform `knowledge/biblicana/hosts.md` and `reading-logs.md`**: move the "replacement host" section to current and remove the "no timestamps" section (the ops-platform side owns those files after hand-off; flag it there).
