# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

**Biblicana** — a Node.js Discord bot for scripture lookups, commentary, cross-references, Bible dictionary, prophecies of Jesus, random verses, and more. Deployed in ~457 Discord servers. Live instance runs on a DigitalOcean droplet managed by PM2.

Repo owner: `BlueBerean` (brand GitHub account). Kenneth/`Nazareneism` is also a contributor.

## Tech stack

- **Runtime**: Node.js 18 (prod uses v18.13.0; local dev uses v18.20.8 via nvm)
- **Discord library**: discord.js 14.14.1 + @discordjs/builders 1.7.0
- **State**: ioredis 5.x (local Redis on the same host as the bot) + pg 8.x (Neon serverless Postgres)
- **Bible data**: SQLite (`data/bible.db` ~131 MB, `data/strongs.db` ~2.7 MB — gitignored, fetched from prod)
- **Package manager**: prod uses `npm` with `package-lock.json`; local dev uses `pnpm@10` with a derived `pnpm-lock.yaml` (local-only)
- **Process manager (prod)**: PM2 v5 (`pm2 list`, `pm2 logs index`, `pm2 restart index`)
- **External APIs**: OpenAI (for `/find` topical search), RapidAPI (dictionaries/definitions), Tavily (on `refactor` branch only, AI web search)

## Repository layout

```
src/
  index.js                # Bot entry; wires up Discord client, loads commands/events/buttons
  config.js               # (refactor branch) Centralized Postgres config object
  commands/               # Slash commands — one file per command (22 total)
  components/buttons/     # Button interaction handlers
  database/
    redisPGHandler.js     # Combined Redis + Postgres wrapper (both are always-available)
    schemas/              # Postgres schema definitions (guild, user)
  events/                 # Discord gateway event handlers (ready, interactionCreate)
  utils/
    bibleHelper.js        # Book-name lookup + verse reference normalization
    logger.js             # Custom logger (prefers console-based output with labels)
    filter.js             # Text filtering / sanitization
    splitString.js        # String chunking for Discord's 2000-char message limit
    axiosInterceptors.js  # (refactor branch) HTTP request/response interceptors
  deploy.js               # One-shot script to register slash commands with Discord

data/
  books.json              # Book-name aliases (committed? — gitignored on main, tracked on refactor's .gitignore loosening)
  bible.db, strongs.db    # SQLite DBs — gitignored everywhere
  prophecies.json, VOTD.json  # (refactor branch) Static datasets for respective commands
```

## Conventions used in this codebase

### Command file structure

Each slash command is a CommonJS module in `src/commands/` exporting:
```js
module.exports = {
  data: new SlashCommandBuilder().setName(...).setDescription(...),
  async execute(interaction, database) { ... }
};
```
The second arg to `execute` is the `redisPGHandler` instance, giving commands access to Redis + Postgres.

### Logging pattern

Log lines are prefixed with a bracketed label identifying the source:
```
[Database] Connected to Redis
[Bible Command] Book lookup for "john"
[Find Command] OpenAI raw response: ...
```
This pattern is load-bearing for grep-based log analysis on prod (e.g., `pm2 logs index --raw | grep '\[RandomVerse Command\]'`). When adding new logging, follow the `[<Area> <Command>]` bracket format.

### Environment variables

All env var names are UPPERCASE, **no underscores** (except `TAVILY_API_KEY` which was added later on refactor with underscores — an inconsistency). Examples: `DISCORDTOKEN`, `CLIENTID`, `GUILDID`, `PGHOST`, `OPENAIKEY`. When adding new vars, match the prevailing style (no underscores) for consistency unless the var follows an external convention.

### Slash command deployment

Never run `src/deploy.js` with the `--global` flag for development. The `deploy` npm script registers commands to a single guild (instant); `deployg` registers globally (up to an hour propagation across all 457 servers). The test bot has its own `CLIENTID` and is deployed to a test guild only.

### Embed colors / chrome

Embed color is `0x083459` (a dark teal). Embed footer, icon, and color values live in `.env` (not hardcoded), so they can be overridden per environment — useful for making local dev visually distinct from prod.

## Development workflow

### Local setup (first time)

See `/Users/kenneth/Development/lionmark/discord-bot/BIBLICANA_OPS.md` for the full replayable steps. Abbreviated:

1. `nvm use` (reads `.nvmrc`, sets Node 18)
2. `pnpm install` (installs 264 deps; `pnpm.onlyBuiltDependencies: ["sqlite3"]` in package.json allows the native binding to build)
3. `scp` `data/books.json`, `data/bible.db`, `data/strongs.db` from prod droplet to local `data/` — these are gitignored runtime requirements, not in the repo
4. `.env` with test bot credentials + Neon dev-branch credentials (dev branch is isolated from prod data)
5. Run `pnpm run deploy` to register slash commands with the test guild
6. `node src/index.js` to start the bot

### Testing changes

All code changes should be tested with the test bot against the test server BEFORE merging to `main`. The prod bot is in 457 Discord servers; breakage affects real users. The test bot token + test server ID are in local `.env`; the Neon `dev-local` branch is a sandbox copy-on-write clone of prod's database.

### Deploying to prod

Prod lives on `biblicana-bot-prod` droplet (`159.65.241.215`). Deployment flow:
1. Push changes to `BlueBerean/Biblicana` on GitHub
2. SSH into the droplet (`ssh root@159.65.241.215`)
3. `cd /root/dev/biblicana && git pull`
4. `npm ci` if `package-lock.json` changed (prod uses npm, not pnpm)
5. `pm2 restart index`
6. `pm2 logs index --lines 30` to verify clean startup

## Known pitfalls

- **`package.json` has ~190 direct dependencies** — most are transitive deps that were accidentally pinned via `npm install --save` in the past. Safe to ignore for normal work; only touch if you're explicitly cleaning up. Real direct deps are ~15 (discord.js, ioredis, pg, dotenv, axios, joi, lodash*, sqlite, sqlite3, undici, ws, chalk, loglevel, js-yaml, magic-bytes.js, node-fetch).
- **`eslint` is in prod `dependencies`, not `devDependencies`** — another consequence of the above. Don't rely on it being in devDeps.
- **`@discordjs/builders` must be a direct dep under pnpm.** The bot's code imports it directly (e.g., `require('@discordjs/builders')` in command files), even though it's technically a transitive dep of `discord.js`. npm flattens everything so this works there; pnpm's strict mode doesn't. On `refactor`, it's been added to `package.json` dependencies explicitly.
- **`sqlite3` native build needs explicit approval under pnpm 10.** `package.json` must include `"pnpm": { "onlyBuiltDependencies": ["sqlite3"] }` or install will skip the postinstall script and leave you with a missing `.node` binding.
- **`.DS_Store` files are tracked in the repo** at the root and `src/`. macOS regenerates them constantly, causing noisy diffs. If you modify the repo from a Mac, expect `.DS_Store` to show up as a local modification; don't commit changes to it.
- **Node version mismatch risk**: prod runs Node v18.13.0 (EOL'd April 2025). When the eventual 24.04 migration happens, we'll move to Node 20 or 22 LTS. Native modules like `sqlite3` will need rebuilding against the new ABI.
- **Never pipe `scp` output** (e.g., `| tail -5`) when copying data files from prod — scp can see the pipe fill and truncate the transfer silently with a clean exit code, producing corrupted files. Run scp without any pipe.
- **Postgres auth failures are logged but not fatal** — `redisPGHandler` continues even if the DB connection fails (`[Database ERR] ... Error creating tables: ...`). This means a broken local `.env` can produce a bot that "looks up" but silently fails every DB-dependent command. Check for `[Database ERR]` lines at startup.
- **`/ping` command does not log anything** — it's a pure latency check, no console.log. Don't use it to verify the bot received a command in log-based tests; use `/randomverse` or `/bible` instead.

## Branches

- `main` — what prod runs. Keep stable. `package.json` still uses npm-centric conventions.
- `refactor` — unmerged WIP with significant improvements: extracted `src/config.js`, async init in `index.js`, generic `loadModules()` helper, `axiosInterceptors` utility, `propheciesofjesus` command + Tavily integration, `VOTD.json` / `prophecies.json` datasets. Local dev environment is set up here, not on main. Intended to eventually merge back.

## References

- **BIBLICANA_OPS.md** (at `../BIBLICANA_OPS.md`, outside this repo) — private ops doc covering DigitalOcean droplets, Neon setup, credentials, SSH access, and the session history of how the environment was bootstrapped. Start here if you need to recover infrastructure state.
- **Upstream**: https://github.com/BlueBerean/Biblicana
- **Discord dev portal**: https://discord.com/developers/applications (both prod and test bot apps owned by Kenneth)
- **Neon console**: https://console.neon.tech — `Biblicana` project holds the live Postgres; `dev-local` branch is the dev sandbox
