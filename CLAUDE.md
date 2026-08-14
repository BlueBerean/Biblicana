# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

**Biblicana** — a Node.js Discord bot for scripture lookups, commentary, cross-references, Bible dictionary, prophecies of Jesus, random verses, and more. Deployed in **~543 Discord servers** (2026-08-03; was 457 in April, 527 in July — it grows, so re-check `/stats` rather than trusting this number). Live instance runs on a DigitalOcean droplet managed by PM2, currently **v1.5.1 on the `refactor` branch**.

Repo owner: `BlueBerean` (brand GitHub account). Kenneth/`Nazareneism` is also a contributor.

## Tech stack

- **Runtime**: Node.js 18 (prod uses v18.13.0; local dev uses v18.20.8 via nvm)
- **Discord library**: discord.js 14.14.1 + @discordjs/builders 1.7.0
- **State**: ioredis 5.x (local Redis on the same host as the bot) + pg 8.x (Neon serverless Postgres)
- **Bible data**: SQLite — all gitignored.
  - On `main`: `bible.db` (~131 MB, verse text + interlinear), `strongs.db` (~2.7 MB, Hebrew/Greek lexicon). Both present on prod.
  - Seven additional local SQLite DBs (~566 MB total): `lxx.sqlite` (6.3 MB, Brenton's English Septuagint 1851, 28,690 verses keyed by MASORETIC coordinates — see `src/buildLxx.js` for why the alignment is non-trivial), `extrabiblical_data.sqlite` (100 MB, 334 authors — 285 patristic plus 49 medieval/modern, see the era-labelling note below — 61k entries), `clean_commentary.db` (428 MB, 6 modern commentators incl. Gill/Clarke/Henry/JFB/Keil/Tyndale, 88k verse + 4.5k chapter-intro entries), `person_places.db` (6.3 MB, biblical figures/places w/ coordinates), `dictionary.sqlite` (5 MB, Easton's + Smith's, 8.4k entries), `cross-references.sqlite` (11 MB, Treasury of Scripture Knowledge, 340k refs), `categories.sqlite` (11 MB, 7.4k topical categories, 406k refs). **All present on prod** since the 2026-06-30 v1.5.0 migration.
- **AI model**: `gpt-5.6-luna` (since v1.5.1). GPT-5 family, so the API surface differs from 4o: `max_completion_tokens` not `max_tokens`, `temperature` accepts only the default, and `max_completion_tokens` INCLUDES hidden reasoning tokens — `reasoning_effort: 'none'` is pinned everywhere for that reason. Chat Completions takes flat `reasoning_effort`; the Responses API nests it as `reasoning.effort`.
- **Package manager**: prod uses `npm`; local dev uses `pnpm@10`. Note `pnpm-lock.yaml` IS tracked in git, while prod's `package-lock.json` is **untracked and stale (v1.4.0)** — so `git pull` never touches it, and `npm ci` should be skipped unless dependencies actually changed.
- **Process manager (prod)**: PM2 v5 (`pm2 list`, `pm2 logs index`, `pm2 restart index`)
- **External APIs**: OpenAI only for AI features — `/find`, the `/web` intent check, `/web` search itself, and AI chat. **Tavily was removed in v1.5.1**; `/web` now uses OpenAI's built-in `web_search` tool restricted to a domain allowlist in `src/utils/webSearch.js` (shared with AI chat's `search_web` tool). RapidAPI still used by `/audio`, `/bookinfo`, `/originaltext`, `/parallel`, `/semantics`, `/topic`; `/dictionary`, `/crossref`, `/topicalindex`, `/commentary` are local SQLite.

## Repository layout

```
src/
  index.js                # Bot entry; wires up Discord client, loads commands/events/buttons
  config.js               # (refactor) Centralized Postgres config object
  commands/               # Slash commands — one file per command (34 on refactor: 33 global
                          #   + /testwelcome, which carries `devOnly: true` and is excluded
                          #   from the global registry by deploy.js)
  components/buttons/     # Button interaction handlers
  components/selects/     # Select-menu handlers (string/channel/role pickers), matched by
                          #   customId at interaction time — NOT registered with Discord,
                          #   so a new one ships on a restart alone (no deploy/deployg)
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
  lxx.sqlite                  # Brenton's English Septuagint (1851), keyed by
                              #   MASORETIC coords; built by src/buildLxx.js
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

All env var names are UPPERCASE, **no underscores**. Examples: `DISCORDTOKEN`, `CLIENTID`, `GUILDID`, `PGHOST`, `OPENAIKEY`. The one exception (`TAVILY_API_KEY`) disappeared with Tavily in v1.5.1, so the convention is now uniform. When adding new vars, match it unless the var follows an external convention.

### Slash command deployment

Never run `src/deploy.js` with the `--global` flag for development. The `deploy` npm script registers commands to a single guild (instant); `deployg` registers globally (up to an hour propagation across all ~543 servers). The test bot has its own `CLIENTID` and is deployed to a test guild only.

### Embed colors / chrome

Embed color is `0x083459` (a dark teal). Embed footer, icon, and color values live in `.env` (not hardcoded), so they can be overridden per environment — useful for making local dev visually distinct from prod.

### AI chat access gates

Four independent gates decide whether the **@mention / reply** conversation fires. All of them live on the guild row and are read in `src/events/messageCreate.js`; **none of them touch slash commands** — `/find`, `/web` and the rest work regardless, and are governed by Discord's own Command Permissions (Server Settings → Integrations), which Discord enforces before the interaction ever reaches the bot.

| Gate | Field | Empty means | Helper |
|---|---|---|---|
| Enabled | `aiEnabled` | off (opt-in) | `readAiEnabled` |
| Where | `aiChannels` | all channels | `isAiChannelAllowed` |
| Who may | `aiRequiredRoles` | everyone | `isAiAllowedForMember` |
| Who may not | `aiDeniedRoles` | nobody blocked | `isAiAllowedForMember` |

Evaluation order inside `isAiAllowedForMember` (`src/utils/aiConfig.js`), and the reasoning that fixes it:

1. **Manage Server → always allowed**, bypassing both role lists. An admin must not be able to lock themselves out of the bot they configure, and testing a setting shouldn't require juggling their own roles.
2. **Denylist → blocks**, even when the member also holds a required role. A `No AI` role stays authoritative without the admin unpicking every other assignment.
3. **Required list → must hold at least one.** Empty means no requirement, which is what keeps guilds configured before this existed unaffected.

Two things that look like bugs and aren't:

- **The two lists fail in OPPOSITE directions** on a member whose roles can't be resolved. `memberRoleIds` returns `[]`, so a denylist can't match (allowed) while a required list can't match (blocked). Each is faithful to its own meaning: "block these" can't block someone unidentifiable, "only allow these" can't allow them.
- **`memberRoleIds` reads two shapes.** A cached `GuildMember` exposes `roles.cache` (a `GuildMemberRoleManager`); raw gateway payloads carry a plain array of ID strings. Reading only `.cache` would see zero roles on the raw shape and silently let a denied member through. Snowflakes stay **strings** end to end — they're 18–19 digits, past `Number.MAX_SAFE_INTEGER`, so anything that coerces one to a Number has already corrupted it and no later `String()` can undo it.

Suppression is **silent** by design — a "you are not allowed" reply would be noisier than the feature it enforces and invites argument in-channel. The trail is `logger.debug('[AiChat] Suppressed by role gate — user=… guild=…')`.

Each `/config ai` select handler re-renders the **whole** panel after saving its own setting, so it must read all the settings it did *not* change. Miss one and the database keeps the right value while the panel renders it as unset — which reads to an admin as their setting having just been cleared. This has been got wrong twice; `tests/aiConfig.test.js` now asserts structurally that every handler calling `buildAiConfigView` sources all five.

## Development workflow

### Local setup (first time)

See `/Users/kenneth/Development/lionmark/discord-bot/BIBLICANA_OPS.md` for the full replayable steps. Abbreviated:

1. `nvm use` (reads `.nvmrc`, sets Node 18)
2. `pnpm install` (installs 264 deps; `pnpm.onlyBuiltDependencies: ["sqlite3"]` in package.json allows the native binding to build)
3. Populate `data/` with the runtime SQLite files (all gitignored):
   - `books.json`, `bible.db`, `strongs.db` — scp from prod droplet
   - You also need: `extrabiblical_data.sqlite`, `clean_commentary.db`, `person_places.db`, `dictionary.sqlite`, `cross-references.sqlite`, `categories.sqlite`. These **are on prod** (since v1.5.0), so scp them from the droplet like the others, or source from Kenneth's local `data/new_data/` archive. See `BIBLICANA_OPS.md`.
4. `.env` with test bot credentials + Neon dev-branch credentials (dev branch is isolated from prod data)
5. Run `pnpm run deploy` to register slash commands with the test guild
6. `node src/index.js` to start the bot

### Testing changes

All code changes should be tested with the test bot against the test server BEFORE deploying `refactor` to the droplet (`main` is not deployed). The prod bot is in ~543 Discord servers; breakage affects real users. The test bot token + test server ID are in local `.env`; the Neon `dev-local` branch is a sandbox copy-on-write clone of prod's database.

### Deploying to prod

Prod lives on `biblicana-bot-prod` droplet (`159.65.241.215`). Deployment flow:
1. Push changes to `BlueBerean/Biblicana` on GitHub
2. SSH into the droplet (`ssh root@159.65.241.215`)
3. `cd /root/dev/biblicana && git pull`
4. `npm ci` if `package-lock.json` changed (prod uses npm, not pnpm)
5. `pm2 restart index`
6. `pm2 logs index --lines 30` to verify clean startup

### Release checklist (version bumps only)

An ordinary deploy is the six steps above. A **version bump** adds these, and
they are ordered because two of them must happen BEFORE the restart.

1. **`package.json` version.** What `pm2 list` reports.
2. **`EMBEDFOOTERTEXT` in the droplet's `.env`** — the version users actually
   see, on the footer of every card. It is a SECOND copy of the version string
   and it does not live in git, so no commit, diff or test can catch it drifting.
   It shipped stale at v1.6.0 and read `v1.5.1` in prod until someone noticed.
   `sed -i "/^EMBEDFOOTERTEXT/s/v1\.5\.1/v1.6.0/" .env`, after `cp .env .env.bak-$(date +%Y%m%d-%H%M%S)`.
   (Deriving it from `package.json` would end this class of bug; deliberately
   not done, so it stays a checklist item.)
3. **New data files, BEFORE the restart.** `data/` is gitignored, so `git pull`
   never brings a new SQLite. `scp` it with NO PIPE — scp can see a pipe fill
   and truncate silently with a clean exit, and a half-copied SQLite has a
   valid header, so early reads succeed and later ones fail hours later in
   prod. Verify with `md5` on both ends, not the exit code.
4. **`npm run deployg` only if a slash command was added, renamed, or had its
   options changed.** Components (buttons, select menus) are matched by
   `customId` at interaction time and need nothing but a restart. Global
   registration takes up to an hour to propagate; it is a `PUT` over the whole
   set, so it cannot duplicate.
5. **Run the tests on the droplet before restarting.** Node 18.13's TAP lexer is
   stricter than local 18.20, and reports per FILE — check subtest counts
   (`node --test tests/x.test.js | grep -cE "^\s+ok"`), not the file total, or a
   file that died mid-parse still shows green.
6. Restart, then verify with a real query against prod's own data — not just a
   clean log. A script that imports a module in isolation does NOT load `.env`
   (only `index.js` does), so anything reading config needs `import
   "dotenv/config"` or it silently reads defaults.

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
- **The "Church Fathers" DB is not all Church Fathers.** `extrabiblical_data.sqlite` holds 334 authors: 285 patristic, plus 49 medieval, Reformation-era and modern writers (Aquinas, C.S. Lewis, Tolkien, at least one living author). Anything surfacing these rows must classify by `default_year` — `classifyFather` for model-facing text, `fatherEraBadge` for UI, both in `studyHelper.js`. Presenting a 1963 author as "the early church" is a factual error, and the two helpers are tested to never disagree.
- **Test names must be ASCII.** Prod's Node 18.13 TAP lexer dies on a non-ASCII character in a `test()` description and reports the whole FILE as 0 passed, naming nothing. Local Node 18.20 parses it fine, so it only shows up on the droplet. Em-dashes are fine in comments, assertions and log lines — just not in test titles.
- **Neon bills compute-time, not queries.** Anything polling on a timer shorter than the ~5-minute autosuspend threshold keeps the endpoint awake permanently, regardless of how few queries it makes. The daily-verse tick did exactly this from 2026-06-30 to 2026-08-01. Cache timer-driven reads in Redis and invalidate on write; see `getDailyVerseGuilds`.

## Branches

- **`refactor` — what prod actually runs**, and has since the v1.5.0 migration on 2026-06-30. This is the working branch: deploys are a `git pull` on the droplet from `refactor`. ESM, 11 real deps, 0 critical Dependabot alerts on its own tree. `/dictionary`, `/crossref`, `/topicalindex` and `/commentary` are local SQLite rather than RapidAPI; `/fathers`, `/persons`, `/places` and `/profile` were added. 34 command files, 33 registered globally (`/testwelcome` is `devOnly`). `/lxx` is the newest and, unlike a component, needed a `deployg`.
- **`main` — stale, NOT deployed.** CommonJS, 190+ deps, 100+ open Dependabot vulnerabilities. Left behind by the refactor and increasingly divergent. **Do not push here**, and do not treat it as production — several docs (including older revisions of this file) wrongly said it was.

### Release history

- `647681e` — slim deps + patch 48+ Dependabot issues
- `6bd3d78` — full ESM migration; 3 new commands; `/dictionary` moved local
- `ef678ad` — `/crossref`, `/topicalindex`, `/commentary` moved local; chapter-level commentary
- **v1.5.0 (2026-06-30)** — first `refactor` deploy to the droplet. Data files uploaded; `main` not deployed since.
- **v1.5.1 (2026-08-03)** — reliability + cost batch: ack-before-I/O across 16 handlers, `pg.Pool` bounds (and a missing `pool.on('error')` listener that could crash the process), Redis negative caching, a single-query daily-verse tick with its guild list cached to stop the 5-minute tick waking Neon, GPT-5.6-Luna with prompt caching, Tavily replaced by OpenAI `web_search` on a domain allowlist, a Sources button on AI answers, era labelling in `/fathers`, and passage-slice anchoring so a passage-grouped commentator answers the verse actually asked about. `followups.md` (gitignored, local-only) has the item-by-item record.
- **post-v1.5.1, deployed 2026-08-11** (shipped ahead of the version bump; folded into v1.6.0 below) — AI chat role gating in `/config ai`: a **blocked-roles** denylist (`228791d`, so a server can hand out a `No AI` role) and a **required-roles** allowlist (`b7c44c2`, so AI chat can be kept to a study group or supporter tier), with blocked overruling required and Manage Server bypassing both. See "AI chat access gates" above. Both are select-menu components, so they needed no `deployg`.
- **v1.6.0 (2026-08-14)** — the Septuagint, AI role gating, and a verse pager. `/lxx` plus a `lookup_lxx` tool over **Brenton's English Septuagint** (`data/lxx.sqlite`, 28,690 verses, seventh SQLite, built by `src/buildLxx.js`); AI-chat **required-roles** and **blocked-roles** gating in `/config ai`; a **paginated passive layout** with owner-locked paging and a jump menu, plus a passive **channel allowlist**; AI answers expand their own citations into a verse card. Accuracy: the **Isaiah/1 Samuel parser collision** (`Isa` read as Roman `I` + `Sa`), continuation lists sharing one book name, replies truncating mid-word at the output ceiling, chapter-only references rendering no text. Announcement copy in `docs/announcements/v1.6.0.md` (gitignored, local-only).

## References

- **BIBLICANA_OPS.md** (at `../BIBLICANA_OPS.md`, outside this repo) — private ops doc covering DigitalOcean droplets, Neon setup, credentials, SSH access, and the session history of how the environment was bootstrapped. Start here if you need to recover infrastructure state.
- **Upstream**: https://github.com/BlueBerean/Biblicana
- **Discord dev portal**: https://discord.com/developers/applications (both prod and test bot apps owned by Kenneth)
- **Neon console**: https://console.neon.tech — `Biblicana` project holds the live Postgres; `dev-local` branch is the dev sandbox
