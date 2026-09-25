# Project Log

Reverse-chronological log of significant changes, incidents and decisions. **New entries go here, below this line.**

Started 2026-09-24 and seeded from the record that existed before it: `CLAUDE.md`'s release history, `FOLLOWUPS.md` (gitignored, local), the Claude memory files, and `git log`. Entries before 2026-09-24 are summaries; the detail lives in those sources, named per entry. Dates are when a change was made or deployed, as stated; where two sources disagree, both are given.

## 2026-09-25

### Every command reports its own errors to Sentry

The failed `/stats` of 04:51 hit 10062 and never reached Sentry: `stats.js` caught it, apologised, and reported nothing. It wasn't alone — **119 catch blocks in 55 files** logged errors that never reached Sentry, because most commands catch and apologise instead of rethrowing to the dispatcher. Now **93 outer catch sites report** (89 added by a scripted edit, dry-run first, every site reviewed by its log message; 4 already did).

- **Rules:** report in the outer catch; not in the 27 nested "couldn't send the apology" catches (they would double every report); not in the 3 that rethrow (the dispatcher reports those); and beside the `logger.error`, so existing `isExpiredInteractionError` guards keep expired-menu noise out.
- **Interaction scope:** `withReportingScope` in `interactionCreate` gives each interaction a Sentry scope with guild/area/handler. Verified first against the real SDK that tags survive awaits and stay isolated between concurrent interactions. The 10062 fingerprint now reads the inherited handler too.
- **Tests (373 total):** `tests/errorReporting.test.js` runs the real Sentry SDK with a recording transport — including `/stats` end to end, and "reported once even when the apology also fails". `tests/catchReporting.test.js` scans all four directories and asserts a lower bound on what it found, so a blind scanner can't pass. Mutation-checked three ways (remove the /stats report, double-report in the nested catch, drop the command scope); each caught.
- **Left, deliberately:** 33 catches in `src/utils/` and `src/database/`. The 2026-07-19 Neon outage logged 171,238 errors in a day; per-query reporting would burn the monthly quota in hours. Needs rate-limited reporting first.
- Also fixed: `errorReporting.js` pointed readers at `docs/10062-diagnostic.md`, which is about a different bot.
- **Deployed 06:19 UTC** (`e788ef8`): 373/373 tests on the prod droplet first, ~9 s restart, `environment=production`, heartbeat check-in from the new process the same second, 0 errors.

### Prod moved to the new droplet — cutover 04:35:43 -> 04:35:57 UTC (~14 s down)

Ran `docs/ops/host-migration-2026-09.md` the same night, Kenneth approving each gate. New host `biblicana-bot-prod-2` (Ubuntu 24.04, 1 vCPU / 2 GB, NYC3), tailnet name `biblicana`, `tag:prod`.

- **Build:** bootstrap waited out cloud-init (it held the apt lock, and `do-agent` only went active after it); Tailscale joined as a tagged device (no key expiry); public SSH closed only after tailnet SSH was proven, then verified three ways: tailnet login works, root refused, public :22 silent.
- **App and data:** cloned `refactor` at `ae31899`, pnpm from the tracked lockfile; `sqlite3` and the profiler load on Node 22. Data pulled from prod and pushed over the tailnet: **md5-identical on both hosts, 14 files**. 358/358 tests on the host against it. The runbook's md5 command was wrong (the `cd` into the 750 directory needed `sudo` too): fixed.
- **`.env`:** prod's copied host to host without touching the Mac's disk, verified by key counts only; `NODE_ENV=production` added; `SENTRYDSN` piped in by Kenneth (Claude is barred from reading local `.env`, and kept it that way). Smoke file = the local test-bot `.env` minus the dev flags, plus `SENTRYENVIRONMENT=staging`; the two files' Discord tokens compared by hash to prove they differ.
- **Smoke test** on the test bot: every command, button and AI chat worked, logs timestamped, traces in Sentry `staging`. **Reboot test:** booted 9 s after the command, bot back and logged in 29 s after boot, unattended — the old host never could.
- **Cutover:** `environment=production`, the PROD bot (`Biblicana#7650`) logged in, `biblicana-gateway` was created by its first check-in in the same second, top.gg got `server_count=592` (572 on 2026-09-06), a real `/bible` in a prod server. 0 errors.

**DigitalOcean resource alerts** on tag `biblicana` (email): memory >90% for 5 min, 5-min load average >3 for 10 min (the one that would have caught 2026-09-05, when load hit 13 with CPU idle), disk >80% for 5 min.

**Old droplet snapshotted (`biblicana-bot-prod-final-2026-09-25`) and destroyed** the same night instead of after a week: the new host had passed every check, and the old one was an unpatched internet-facing box holding prod's `.env`. Code rollback is in-branch; the host-level rollback is now "restore the snapshot" (~10 min). `biblicana-bot-legacy-abandoned` (orphaned since at least April) was already gone from the account.

**DO cloud firewall** attached to the new droplet at ~04:51 (no inbound rules, applied by droplet name so the old droplet's rollback SSH stays open). Attaching it stalled established connections for about a minute: tailnet SSH timed out once, and one `/stats` hit 10062 because its event arrived already expired (no gateway reconnect was logged, so the socket stalled rather than dropped). Public :22 and ICMP are now dropped at the cloud firewall too; tailnet, Discord and outbound HTTPS unaffected.

Old droplet: bot stopped and saved, nothing else touched: the rollback, until snapshot and destroy (~7 days). `CLAUDE.md`, the ops knowledge pack and Claude's memory now describe the new host. Still open: the DO cloud firewall and alert policies (Kenneth), `opsreader` and Beszel (with lionmark-ops).

### Prod SSH: password authentication turned off (ops, on Kenneth's go)

Checking the droplet for the ops handoff found root with a password and `sshd -T` reporting `passwordauthentication yes`, with no firewall and no fail2ban: ~100k failed guesses in 12 days (~8,500 a day). The config files disagreed, and sshd keeps the FIRST value it reads: `50-cloud-init.conf` (yes) comes before `60-cloudimg-settings.conf` (no). Every successful login in the retained auth logs (~5 weeks) was by key, one key (this Mac's), from two Comcast addresses; the second matched the 2026-09-24 21:47 deploy to the minute. Turned off in `50-cloud-init.conf` (backup beside it), validated with `sshd -t`, reloaded; verified a new key login works and a password attempt is refused `(publickey)`. Root login by key remains until the migration.

### What the droplet turned out to be, and the decision to replace it

Read-only checks for the handoff's section A (full answers in `ops-platform/handoffs/responses/biblicana.md`): **Ubuntu 23.10, out of support since July 2024**, 886 days' uptime, `reboot-required` set, 63 pending upgrades; **nothing starts PM2 at boot** (no unit, no `@reboot`), so any reboot would leave the bot down; `NODE_ENV` unset, so prod has always logged at debug and Sentry would have labelled prod `development`; PM2 logs carry **no timestamps**; `pm2-logrotate` IS installed (since 2026-09-05; `FOLLOWUPS.md` said otherwise). Kenneth chose a **fresh 2 GB Ubuntu 24.04 droplet**, old one kept as rollback: `docs/ops/host-migration-2026-09.md` and `docs/ops/scripts/01-07`, plus `ecosystem.config.cjs` so the start command (`--import`, timestamps, log paths, 400 MB) lives in git. Prepared, not run.

### Sentry follow-ups from the first real traffic

- **Discord interaction tokens were in every traced HTTP span** (URL paths, where query stripping never looks) — redacted by pattern across all span attributes; mutation-checked. See the 2026-09-24 entry.
- **Trace sampling default 0.1 -> 1.** Seven days of prod logs: 5-22 slash commands and 7-40 buttons a day across ~570 servers — ~30k spans a month against 5M included. The 0.1 guess would have left prod with one or two traces a day.
- **`LOGLEVEL`** added to `logger.js`: `NODE_ENV=production` would otherwise silently drop debug-only trails such as the AI role-gate suppression line.

### Neon ops role and the ops knowledge pack

`docs/ops/neon-ops-reader.sql`: an `ops_reader` role with read-only transactions, a 5 s statement timeout, and SELECT on four aggregate views in schema `ops` — **no grant on either table**. Postgres turned out to hold no user-written text at all (AI chat history is in Redis), but its rows are keyed by Discord IDs and ops needs counts. The view bodies were run read-only against `main` to prove they parse and return. Also written: the eight `ops-platform/knowledge/biblicana/` files and the handoff response, including the F table. Found on the way: `docs/10062-diagnostic.md` is about a different bot (disnake on OVH) and must not be used for Biblicana's 10062s; `.gitignore` now covers `.env.*` except the example.

358 tests, lint clean, ShellCheck clean on the scripts.

## 2026-09-24

### Sentry, a gateway heartbeat, and Node 22 (uncommitted, not deployed)

The ops-platform handoff (`ops-platform/handoffs/biblicana.md`, section B) asked for error reporting and a heartbeat, because the bot had neither: an outage was noticed when a user said so. Done on `refactor`, tested, not deployed.

- **Node 18 -> 22.** Sentry's ESM auto-instrumentation needs `node --import`, which needs 18.19+; prod runs 18.13, end-of-life since April 2025. Kenneth chose to take the upgrade now rather than separately. `engines` `>=22 <23` (the tracked pin; `.nvmrc` is excluded per machine), `sqlite3` rebuilt; the 317 existing tests passed unchanged on 22 before any new code went in. Prod gets it through the host migration (2026-09-25 entry), not an in-place upgrade.
- **Sentry** (`@sentry/node` + `@sentry/profiling-node` 11.0.0, project `lionmark/biblicana`, Team plan, $20 pay-as-you-go cap for profiling). `src/instrument.js` is preloaded by `pnpm start`; `SENTRYDSN` absent means off, like `TOPGGTOKEN`. Errors are captured in the interaction and message handlers and in AI chat's four internal catch blocks, which swallow everything and so would otherwise report nothing. Every command, button, select and AI chat is a root span; passive detection is deliberately untraced (it runs on every message).
- **Privacy, verified against what Sentry stored, not just what was sent.** The largest leak was not in the handoff's list: Sentry's Console integration ships the bot's recent log lines with every error, and those carry AI chat text. Console breadcrumbs are dropped; text and name keys are redacted at any depth; outbound URLs lose their query strings. A live test planted five secrets and read the event back from Sentry: all five absent, guild/area/handler tags present. The same test surfaced `user.geo` derived server-side from the sending IP — "Prevent Storing of IP Addresses" is now on for the project.
- **Heartbeat as a Sentry Cron Monitor** (`biblicana-gateway`, every 5 min, alerts after two missed), production only, since a dev bot stopped for the night must not page. Chosen over Healthchecks.io for one account and one dashboard; the trade is no heartbeat alerts during a Sentry outage.
- **The handoff's suggested health check would never have fired.** It proposed `client.isReady()` plus `ws.status === Ready`. In discord.js 14.26 both read the MANAGER's status, which is set once on first READY and never reset; a dropped socket moves only `shard.status`. The heartbeat checks every shard; mutating it back to the handoff's version fails five tests.
- **Discord interaction tokens were in every traced HTTP span**, found in the first live trace, not by any test: they sit in the URL path (`/interactions/<id>/<token>/callback`, `/webhooks/<app_id>/<token>/…`), where query-string stripping never looks. Each lets its holder post and edit as the bot — 15 minutes for an interaction, forever for a channel webhook. Redacted by pattern across span names, every string attribute and breadcrumb URLs; the dev tokens already stored had expired by the time they were found.
- **Sentry 11 ignores `beforeSendTransaction`** under its default span streaming — the span scrubber lives in `beforeSendSpan` against the streamed `{ name, attributes }` shape. Found at boot by an SDK warning, not by the docs.
- **Prod requirement:** the droplet's `.env` must set `NODE_ENV=production` or `SENTRYENVIRONMENT=production`. Without it prod reports as `development` and the heartbeat never starts, so its monitor is never created and can never alert.

351 -> 352 tests, lint clean. Files: `src/instrument.js`, `src/utils/{sentryConfig,sentryScrub,errorReporting,heartbeat}.js`, `tests/{sentry,heartbeat}.test.js`.

### Haley and Torrey on Bible difficulties (`0d9b488`, cache key v16 -> v20)

Two public-domain works on alleged contradictions (1874, 1907) as an optional data file (`data/difficulties.sqlite`) and a `lookup_difficulty` tool, standing in for Archer's *Encyclopedia of Bible Difficulties* while Zondervan's permission is pending. Detail in `CLAUDE.md` release history and the "Haley and Torrey" pitfall.

### A reference must exist before it becomes a card (`d46dfc2`)

"Romans 17:1" parsed and posted a card with no scripture. `src/utils/versification.js` now checks every chapter and verse against `bible.db`, failing open.

### Alleged contradictions answered with the evidence (`90bf450`, `7c8f5ea`, `4fe8de3`, v12 -> v16)

Pressed on 2 Sam 21:19, the bot conceded the BSB was "dishonest". Grounding now carries across pushback turns, BSB translator footnotes reach the model, and the interlinear's KJV glosses are no longer presented as the Hebrew. The lesson recorded in `CLAUDE.md`: a firmer prompt with a fact missing produced a more confident wrong answer, four times.

## 2026-09-17

### The prompt holds one position across a long argument (`886b662`, v10 -> v12)

Offered three fulfilments of Matt 16:28 in three messages and ended by conceding. The cause was routing — the question was filed under eschatology timing rather than Scripture's reliability. Deployed 2026-09-17.

## 2026-09-16

### AI chat honesty under pressure and under a word limit (`9392ec5`, v6 -> v10)

Four prompt guards after live failures ("Pope" in one word; reversing on displeasure alone). Also `459b90c` (a failed lookup is no longer listed as a source; a `LIKE` wildcard bug) and `baad3ad` (vatican.va on the web allowlist). Deployed 2026-09-16.

## 2026-09-06

### v1.6.1 (`1c3bf4d`)

One-chapter books ("Jude 5"), four independent verse renderers each truncating with no way out, `/config ai` rejected by Discord at ~10 channels, ESLint having parsed nothing since the ESM migration, and a retry for queries lost to a cold Neon endpoint plus gateway lifecycle logging. No `deployg`. Server count 572. Detail in `CLAUDE.md`.

## 2026-09-05

### Page-cache starvation on the droplet (ops, no commit)

Load 13 with CPU near idle, `available` at 26 MB, `ps` hanging 100+ s — while `pm2 list` showed the bot `online` throughout and nothing was OOM-killed. SQLite leans on the kernel page cache, and ~700 MB of it on a 952 MB box had been squeezed out. Fixed with a 2 GB swapfile (`vm.swappiness=10`) and a masked `fwupd`. Diagnose with `free -m` and load-vs-CPU, not the bot's logs. The durable fix is a 2 GB droplet. Source: memory `project_droplet_capacity`.

## 2026-08-14

### v1.6.0 (`45179ba`)

`/lxx` and Brenton's Septuagint (seventh SQLite), AI role gating, a paginated passive layout, citation expansion in AI answers. Needed a `deployg`. The embed footer shipped reading v1.5.1, which is why the release checklist in `CLAUDE.md` exists.

## 2026-08-11

### AI chat role gating deployed ahead of v1.6.0 (`228791d`, `b7c44c2`)

A blocked-roles denylist and a required-roles allowlist in `/config ai`, blocked overruling required, Manage Server bypassing both.

## 2026-08-04

### v1.5.1 deployed (`564a3c7`)

Commit dated 2026-08-03; `FOLLOWUPS.md` records the deploy as 2026-08-04 and six days' verified uptime to 2026-08-10. Ack-before-I/O across 16 handlers, `pg.Pool` bounds and a missing `pool.on('error')`, Redis negative caching (hit rate 2.6% -> 83-100%), the daily-verse tick cut from 527 queries to 1 so Neon could sleep again, `gpt-5.6-luna`, Tavily replaced by OpenAI `web_search` on an allowlist. **The 10062 count did not change** — ack-before-I/O was not the cause. 45 -> 93 tests.

## 2026-07-19

### Neon compute quota exhausted; upgraded to the Launch plan (ops)

Every Postgres read and write failed for most of a day (171,238 quota errors). Every DB-backed feature failed soft, so the bot stayed "up" while doing nothing. Kenneth upgraded Neon mid-outage; the leaks that consumed the quota were fixed in v1.5.1. Source: `FOLLOWUPS.md` 2026-07-19/20 section, memory `project_prod_deploy_state`.

## 2026-06-30

### v1.5.0 — first `refactor` deploy with the new data (`9d4c074`)

The six additional SQLite files uploaded to the droplet; `main` has not been deployed since. Prod runs `refactor` with npm, not pnpm.

## 2026-06-18

### MessageContent privileged intent approved

Applied 2026-04-23, approved after about two months (Discord reviews it manually past 100 servers; 512 at the time). Unblocked passive scripture detection and the AI chat layer. AI chat tool-calling was built the same week. Source: memory `project_message_content_intent`.

## 2026-04-16

### v1.4.0 — the refactor reaches prod (`0651f81`)

In one day on `refactor`: dependencies slimmed from 190+ to 11 and 48+ Dependabot alerts closed (`647681e`), the full ESM migration with `/fathers`, `/persons`, `/places` and local `/dictionary` (`6bd3d78`), `/crossref`, `/topicalindex` and `/commentary` moved to local SQLite (`ef678ad`), a Components V2 pass across most commands, `eval()` removed and the PG upsert parameterised (`6708915`), rate limits and axios timeouts, and unified `[Usage]` logging (`c247c96`). Deployed to the droplet the same day. Source: `git log`, memory `reference_droplet_deploy`.

## 2024-01-03

### Initial commit (v1.0.0)
