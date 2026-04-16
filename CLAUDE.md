# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

**Biblicana** — a Node.js Discord bot for scripture lookups, commentary, cross-references, Bible dictionary, prophecies of Jesus, random verses, and more. Deployed in ~457 Discord servers. Live instance runs on a DigitalOcean droplet managed by PM2.

Repo owner: `BlueBerean` (brand GitHub account). Kenneth/`Nazareneism` is also a contributor.

## Tech stack

- **Runtime**: Node.js 18 (prod uses v18.13.0; local dev uses v18.20.8 via nvm)
- **Discord library**: discord.js 14.14.1 + @discordjs/builders 1.7.0
- **State**: ioredis 5.x (local Redis on the same host as the bot) + pg 8.x (Neon serverless Postgres)
- **Bible data**: SQLite — all gitignored.
  - On `main`: `bible.db` (~131 MB, verse text + interlinear), `strongs.db` (~2.7 MB, Hebrew/Greek lexicon). Both present on prod.
  - On `refactor`, six additional local SQLite DBs (~560 MB total): `extrabiblical_data.sqlite` (100 MB, 334 Church Fathers, 61k entries), `clean_commentary.db` (428 MB, 6 modern commentators incl. Gill/Clarke/Henry/JFB/Keil/Tyndale, 88k verse + 4.5k chapter-intro entries), `person_places.db` (6.3 MB, biblical figures/places w/ coordinates), `dictionary.sqlite` (5 MB, Easton's + Smith's, 8.4k entries), `cross-references.sqlite` (11 MB, Treasury of Scripture Knowledge, 340k refs), `categories.sqlite` (11 MB, 7.4k topical categories, 406k refs). **Not on prod yet** — require upload as part of any refactor-to-prod migration.
- **Package manager**: prod uses `npm` with `package-lock.json`; local dev uses `pnpm@10` with a derived `pnpm-lock.yaml` (local-only)
- **Process manager (prod)**: PM2 v5 (`pm2 list`, `pm2 logs index`, `pm2 restart index`)
- **External APIs**: OpenAI (`/find`, `/web` intent check), Tavily (on `refactor`, `/web` AI search). RapidAPI still used by `/audio`, `/bookinfo`, `/originaltext`, `/parallel`, `/semantics`, `/topic` — but on `refactor`, `/dictionary`, `/crossref`, `/topicalindex`, `/commentary` have all been moved to local SQLite and no longer hit RapidAPI.

## Repository layout

```
src/
  index.js                # Bot entry; wires up Discord client, loads commands/events/buttons
  config.js               # (refactor) Centralized Postgres config object
  commands/               # Slash commands — one file per command (26 on refactor, 22 on main)
  components/buttons/     # Button interaction handlers
  database/
    redisPGHandler.js     # Combined Redis + Postgres wrapper (both always-available)
    schemas/              # Postgres schema definitions (guild, user)
  events/                 # Discord gateway event handlers (ready, interactionCreate)
  utils/
    bibleHelper.js        # bibleWrapper + strongsWrapper singletons + getBookId / numbersToBook
    studyHelper.js        # (refactor) Wrappers for the 6 new SQLite sources: fathersWrapper,
                          #   personsWrapper, placesWrapper, dictionaryWrapper, crossRefWrapper,
                          #   categoriesWrapper, commentaryWrapper. Also hosts book-name
                          #   conversion helpers (toTSKSourceBook, toCommentaryBookCodes, etc.)
    logger.js             # Custom logger (prefers console-based output with labels)
    filter.js             # Text filtering / sanitization
    splitString.js        # String chunking for Discord's embed description limit
    axiosInterceptors.js  # (refactor) HTTP request/response interceptors
  deploy.js               # One-shot script to register slash commands with Discord

data/                     # All files gitignored
  books.json              # Book-name aliases
  bible.db, strongs.db    # Core Bible + lexicon SQLite DBs (present on both main and refactor)
  prophecies.json, VOTD.json  # (refactor) Static datasets
  # refactor-only:
  extrabiblical_data.sqlite   # Church Fathers commentary
  clean_commentary.db         # 6 modern commentators
  person_places.db            # Biblical figures + locations
  dictionary.sqlite           # Easton's + Smith's
  cross-references.sqlite     # TSK cross-references
  categories.sqlite           # Topical index
```

**New commands on `refactor`**: `/fathers` (Early Church Fathers on a verse), `/persons` (biblical figure bio), `/places` (location + coordinates), `/profile` (Tyndale encyclopedic articles on people/groups/topics). These don't exist on `main`.

## Conventions used in this codebase

### Command file structure

Each slash command is one file in `src/commands/`. Shape is the same on both branches, module system differs:

- On `main`: CommonJS — `module.exports = { ... }`, `const { ... } = require('...')`
- On `refactor`: ESM — `export default { ... }`, `import { ... } from '...'`. `package.json` has `"type": "module"`.

```js
// refactor (ESM)
export default {
  data: new SlashCommandBuilder().setName(...).setDescription(...),
  async execute(interaction, database) { ... }
};
```

The second arg to `execute` is the `redisPGHandler` instance, giving commands access to Redis + Postgres (used by commands that persist user preferences like `/setversion` or read them like `/bible`).

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
3. Populate `data/` with the runtime SQLite files (all gitignored):
   - `books.json`, `bible.db`, `strongs.db` — scp from prod droplet
   - On `refactor` you also need: `extrabiblical_data.sqlite`, `clean_commentary.db`, `person_places.db`, `dictionary.sqlite`, `cross-references.sqlite`, `categories.sqlite`. These are **not on prod yet** — source from Kenneth's local `data/new_data/` archive (provenance: upstream dataset aggregator). See `BIBLICANA_OPS.md` for details.
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

- **`package.json` deps are branch-specific.** On `main`: 190+ bloated direct deps (accidentally pinned via `npm install --save`), with `eslint` in prod `dependencies` not `devDependencies`. On `refactor`: slimmed to 11 real direct deps + 1 devDep (see commit `647681e`). Don't touch package.json on `main` without planning the pnpm migration at the same time.
- **Six different book-name conventions coexist across refactor's data sources.** Always sample `SELECT DISTINCT book FROM ...` before writing queries against an unfamiliar DB. The conventions: canonical (`"John"`, from `numbersToBook`), compact-lowercase (`"john"` — Church Fathers DB), compact-lowercase-with-variants (`"psalms"` AND `"psalm"` both exist in `extrabiblical_data.sqlite` — also stray cross-book ranges like `"Ephesians 2:2-Philippians"` in `categories.sqlite`), Roman-numeral source (`"I Samuel"` in TSK `source_book`), Arabic target (`"1 Samuel"` in TSK `target_book`), 3-letter OSIS-like uppercase (`"JHN"`, `"1SA"` in `clean_commentary.db`, with mixed-case alternates like `"Ezek"`, `"Phil"` for four books). Conversion helpers live in `src/utils/studyHelper.js`: `toTSKSourceBook`, `toCommentaryBookCodes`, `toCommentaryBookVariants`, `fromCommentaryBookCode`.
- **`@discordjs/builders` must be a direct dep under pnpm.** The bot's code imports it directly (e.g., `require('@discordjs/builders')` in command files), even though it's technically a transitive dep of `discord.js`. npm flattens everything so this works there; pnpm's strict mode doesn't. On `refactor`, it's been added to `package.json` dependencies explicitly.
- **`sqlite3` native build needs explicit approval under pnpm 10.** `package.json` must include `"pnpm": { "onlyBuiltDependencies": ["sqlite3"] }` or install will skip the postinstall script and leave you with a missing `.node` binding.
- **`.DS_Store` files are tracked in the repo** at the root and `src/`. macOS regenerates them constantly, causing noisy diffs. If you modify the repo from a Mac, expect `.DS_Store` to show up as a local modification; don't commit changes to it.
- **Node version mismatch risk**: prod runs Node v18.13.0 (EOL'd April 2025). When the eventual 24.04 migration happens, we'll move to Node 20 or 22 LTS. Native modules like `sqlite3` will need rebuilding against the new ABI.
- **Never pipe `scp` output** (e.g., `| tail -5`) when copying data files from prod — scp can see the pipe fill and truncate the transfer silently with a clean exit code, producing corrupted files. Run scp without any pipe.
- **Postgres auth failures are logged but not fatal** — `redisPGHandler` continues even if the DB connection fails (`[Database ERR] ... Error creating tables: ...`). This means a broken local `.env` can produce a bot that "looks up" but silently fails every DB-dependent command. Check for `[Database ERR]` lines at startup.
- **`/ping` command does not log anything** — it's a pure latency check, no console.log. Don't use it to verify the bot received a command in log-based tests; use `/randomverse` or `/bible` instead.

## Branches

- `main` — what prod runs. CommonJS, npm, 190+ deps, 53 open Dependabot vulnerabilities (4 critical, 28 high). Still hits RapidAPI for dictionary/commentary/crossref/topic index. 22 commands. **Do not push directly here** until `refactor` has been verified in prod.
- `refactor` — ESM-migrated, pnpm, 11 real deps, 0 critical Dependabot alerts on its own tree. Six RapidAPI-dependent commands (`/dictionary`, `/crossref`, `/topicalindex`, `/commentary`) have been replaced with local SQLite. Four new commands added (`/fathers`, `/persons`, `/places`, `/profile`). 26 commands total. Booted and tested end-to-end locally. Major commits in timeline order:
  - `647681e` — slim deps + patch 48+ Dependabot issues
  - `eeee957` — add CLAUDE.md
  - `6bd3d78` — full ESM migration; add 3 new commands; migrate `/dictionary` to local
  - `ef678ad` — migrate `/crossref`, `/topicalindex`, `/commentary` to local; add chapter-level commentary; default commentator → JFB
  - (uncommitted local) — add `/profile` command; strip debug-log spam from `bible.js`
- All refactor changes remain unmerged until a deliberate droplet-migration push (upload data files, switch branch, pnpm install on droplet, pm2 restart).

## References

- **BIBLICANA_OPS.md** (at `../BIBLICANA_OPS.md`, outside this repo) — private ops doc covering DigitalOcean droplets, Neon setup, credentials, SSH access, and the session history of how the environment was bootstrapped. Start here if you need to recover infrastructure state.
- **Upstream**: https://github.com/BlueBerean/Biblicana
- **Discord dev portal**: https://discord.com/developers/applications (both prod and test bot apps owned by Kenneth)
- **Neon console**: https://console.neon.tech — `Biblicana` project holds the live Postgres; `dev-local` branch is the dev sandbox
