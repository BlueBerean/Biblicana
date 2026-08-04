import pg from 'pg';
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import userModel from './schemas/user.js';
import guildModel from './schemas/guild.js';

// Only these key prefixes may map to Postgres tables. Guards against both SQL
// injection via crafted keys and silent typos that would hit a nonexistent table.
const ALLOWED_TABLE_PREFIXES = new Set(['user', 'guild']);

// Negative-cache sentinel. getValue used to cache only HITS, so every key with
// no Postgres row was a guaranteed cache miss forever: the bot is in 527 guilds
// but `guilddata` holds ~26 rows, so ~501 guilds hit Postgres on every single
// read. Redis bore this out — 3,133,480 misses against 82,366 hits (a 2.6% hit
// rate) with evicted_keys: 0, meaning nothing was evicting the cache, it simply
// was never populated for those keys.
//
// The sentinel is deliberately NOT valid JSON. It is checked before JSON.parse,
// but if that check were ever bypassed the parse would throw and the existing
// corrupt-cache handler would fall through to Postgres — so the worst failure
// mode is a redundant query, never a wrong answer.
const MISS_SENTINEL = '__MISS__';

// Short TTL, unlike the 6h used for real records. A tombstone is an assertion
// about absence, and absence is the thing most likely to change out from under
// us (a guild configuring something for the first time). Writes through
// setValue overwrite the same key, so the normal path clears it immediately —
// this TTL only bounds staleness for rows created OUTSIDE setValue.
const MISS_TTL_SECONDS = 600;

function tableForKey(key) {
    const prefix = String(key).split(':')[0];
    if (!ALLOWED_TABLE_PREFIXES.has(prefix)) {
        throw new Error(`[Database] Invalid key prefix: ${prefix}`);
    }
    return `${prefix}data`;
}

/**
 * Unified Redis + Postgres data layer.
 * @param {Object} postgresConfig - Postgres connection config
 * @param {Object} [redisConfig] - Redis connection config (optional)
 * @param {Number} [redisExpiry] - Redis key expiry seconds (optional)
 */
class DatabaseHandler {
    constructor(postgresConfig, redisConfig = null, redisExpiry = 21600) {
        this.pg = new pg.Pool(postgresConfig);
        this.redis = new Redis(redisConfig);
        this.expiry = redisExpiry;
        this.poolMonitor = null;

        // Cache-effectiveness counters, reported by startPoolMonitor. Held
        // in-process rather than in Redis so reading them costs nothing, and
        // reset each reporting window so the numbers describe recent behaviour
        // rather than lifetime totals.
        this.cacheStats = { hits: 0, misses: 0, negHits: 0 };

        // REQUIRED, not optional telemetry. `pg.Pool` emits 'error' when an
        // IDLE client dies out-of-band — Neon reaping an idle connection, a TLS
        // reset, `Connection terminated unexpectedly`. Node treats an 'error'
        // event with no listener as an uncaught exception and KILLS the
        // process. This listener is what stops an ordinary Neon idle-reap from
        // restarting the bot.
        this.pg.on('error', (err) => {
            logger.error(`[Database Pool] Idle client error: ${err.message} (code=${err.code ?? 'none'})`);
        });

        this.redis.on('connect', () => {
            logger.debug('[Database] Connected to Redis');
        });
        this.redis.on('error', (err) => {
            logger.error(`[Database] Redis error: ${err.message}`);
        });
    }

    async initialize({ retries = 3, backoffMs = 2000 } = {}) {
        logger.debug('[Database] Initializing Database Handler...');

        // Retry with backoff: a Neon endpoint in autosuspend can take longer to
        // wake than `connectionTimeoutMillis` allows, and a bot that boots while
        // the DB is cold would otherwise come up permanently DB-less until the
        // next restart. Transient wake failures are expected; only give up after
        // several attempts.
        let delay = backoffMs;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await this.createTables();
                // Probe that the pool can actually execute queries — createTables can
                // succeed against a cached schema while the session is unusable.
                await this.pg.query('SELECT 1');
                logger.info(`[Database] Database Handler Initialized${attempt > 1 ? ` (attempt ${attempt}/${retries})` : ''}.`);
                this.startPoolMonitor();
                return;
            } catch (err) {
                if (attempt === retries) {
                    logger.error(`[Database] Init failed after ${retries} attempts: ${err.message}`);
                    throw err;
                }
                logger.warn(`[Database] Init attempt ${attempt}/${retries} failed: ${err.message} — retrying in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            }
        }
    }

    // Periodic pool-saturation telemetry. Deliberately silent when healthy: it
    // logs only when callers are actually QUEUED waiting for a connection, which
    // is the leading indicator of the exhaustion the pool timeouts exist to
    // bound. `waiting > 0` sustained across ticks means the pool is the
    // bottleneck, not the database.
    startPoolMonitor(intervalMs = 60000) {
        if (this.poolMonitor) return;
        this.poolMonitor = setInterval(() => {
            const { totalCount, idleCount, waitingCount } = this.pg;
            if (waitingCount > 0) {
                logger.warn(`[Database Pool] Saturated — waiting=${waitingCount} total=${totalCount} idle=${idleCount}`);
            }

            // Cache effectiveness. `negHit` counts reads served entirely from
            // the negative cache — before tombstones existed every one of those
            // was a Postgres round trip, and they were the bulk of the traffic.
            const { hits, misses, negHits } = this.cacheStats;
            const total = hits + misses + negHits;
            if (total > 0) {
                const rate = (((hits + negHits) / total) * 100).toFixed(1);
                logger.debug(`[Database Cache] hit=${hits} negHit=${negHits} miss=${misses} rate=${rate}% window=${intervalMs / 1000}s`);
                this.cacheStats = { hits: 0, misses: 0, negHits: 0 };
            }
        }, intervalMs);
        // Don't hold the event loop open on shutdown.
        this.poolMonitor.unref?.();
    }

    async createTables() {
        await this.pg.query(`
            CREATE TABLE IF NOT EXISTS guilddata (
                id varchar(255) PRIMARY KEY,
                data JSONB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS userdata (
                id varchar(255) PRIMARY KEY,
                data JSONB NOT NULL
            );
        `);
        logger.debug('[Database] Tables created successfully.');
    }

    // User functions
    async setUserValue(id, value) {
        return this.validateAndSetValue(`user:${id}`, value, userModel);
    }

    async getUserValue(id) {
        return this.getValue(`user:${id}`);
    }

    async updateUserValue(id, value) {
        return this.updateValue(`user:${id}`, value, userModel);
    }

    async deleteUserValue(id) {
        return this.deleteValue(`user:${id}`);
    }

    // Guild functions
    async setGuildValue(id, value) {
        return this.validateAndSetValue(`guild:${id}`, value, guildModel);
    }

    async getGuildValue(id) {
        return this.getValue(`guild:${id}`);
    }

    async updateGuildValue(id, value) {
        return this.updateValue(`guild:${id}`, value, guildModel);
    }

    async deleteGuildValue(id) {
        return this.deleteValue(`guild:${id}`);
    }

    // Single-query lookup of every guild with daily verse enabled.
    //
    // Replaces the scheduler's previous pattern of iterating
    // `client.guilds.cache` (527 guilds) and calling getGuildValue on each one
    // every 5 minutes: ~144,000 queries/day to find ~14 guilds, and the single
    // largest consumer of the Neon compute quota during the 2026-07-19 outage
    // (`[DailyVerse]` was 153,555 of 171,238 quota errors).
    //
    // Deliberately bypasses Redis. This is a whole-table predicate, not a key
    // lookup, so there is no single cache key that could represent it — and
    // caching it would be actively wrong, since a guild toggling daily verse
    // off must take effect on the next tick. Per-guild writes still go through
    // the normal cached path via saveDailyVerseConfig.
    async getDailyVerseGuilds() {
        const { rows } = await this.pg.query(
            `SELECT id, data FROM guilddata WHERE data->'dailyVerse'->>'enabled' = 'true'`
        );

        logger.debug(`[Database] getDailyVerseGuilds — ${rows.length} enabled guild(s) in one query`);

        // The `id` column holds the namespaced key (`guild:<snowflake>`) because
        // that is what setValue writes. Strip the prefix so callers get raw
        // guild IDs they can hand straight to `client.guilds.cache.get()`.
        return rows.map(row => ({
            guildId: String(row.id).replace(/^guild:/, ''),
            dailyVerse: row.data?.dailyVerse ?? null,
        }));
    }

    // Fixed-window rate limit on a (scope, userId) pair. Returns
    // { allowed, count, retryAfterSeconds }. Fails open on Redis errors so
    // a Redis blip doesn't brick paid commands for every user at once.
    async checkRateLimit(scope, userId, { limit, windowSeconds }) {
        // Dev bypass: DISABLE_RATE_LIMITS=1 short-circuits every rate-limited
        // command (aichat, find, web, etc.) without touching Redis. Loud
        // startup warning in index.js surfaces when this is on. NEVER set
        // this in production — it opens the bot to abusive usage and could
        // run up significant OpenAI bills.
        if (process.env.DISABLE_RATE_LIMITS) {
            return { allowed: true, count: 0, retryAfterSeconds: 0 };
        }
        try {
            const key = `ratelimit:${scope}:${userId}`;
            const count = await this.redis.incr(key);
            if (count === 1) {
                await this.redis.expire(key, windowSeconds);
            }
            if (count > limit) {
                const ttl = await this.redis.ttl(key);
                return { allowed: false, count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
            }
            return { allowed: true, count, retryAfterSeconds: 0 };
        } catch (error) {
            logger.error(`[RateLimit] Redis failure (${scope}:${userId}): ${error.message}`);
            return { allowed: true, count: 0, retryAfterSeconds: 0 };
        }
    }

    async updateValue(key, value, schema) {
        const originalValue = await this.getValue(key);

        if (!originalValue) {
            logger.error(`[Error] Key ${key} not found`);
            return false;
        }

        const replacedValue = this.fillProperties(originalValue, value);
        return this.validateAndSetValue(key, replacedValue, schema);
    }

    async validateAndSetValue(key, value, schema) {
        const { error } = schema.validate(value);

        if (error) {
            logger.error('[Error] Error validating user:', error);
            return false;
        }

        return this.setValue(key, value);
    }

    // Merges newValue into originalValue and returns the merged object.
    // Throws on unknown property — previously this path returned the boolean
    // `false` from a function whose contract is "return an object", which
    // silently tripped schema validation downstream with a misleading error.
    fillProperties(originalValue, newValue) {
        for (const key in newValue) {
            if (originalValue[key] === undefined) {
                throw new Error(`[Database] Property '${key}' does not exist on original value for update`);
            }
            originalValue[key] = newValue[key];
        }
        return originalValue;
    }

    async getValue(key) {
        const cachedValue = await this.redis.get(key);

        // Negative cache hit: we have already asked Postgres for this key and
        // it had no row. Checked BEFORE the JSON.parse below, since the
        // sentinel is intentionally not valid JSON.
        if (cachedValue === MISS_SENTINEL) {
            this.cacheStats.negHits++;
            return null;
        }

        if (cachedValue) {
            // A corrupt cache entry (partial write, manual redis-cli set, version
            // skew) must not throw into every getGuildValue/getUserValue caller —
            // treat a parse failure as a cache miss and fall through to Postgres.
            try {
                const parsed = JSON.parse(cachedValue);
                this.cacheStats.hits++;
                return parsed;
            } catch (err) {
                logger.warn(`[Database] Corrupt cache for ${key}; falling through to Postgres: ${err.message}`);
            }
        }

        this.cacheStats.misses++;

        const table = tableForKey(key);
        const { rows } = await this.pg.query(
            `SELECT * FROM ${table} WHERE id = $1`,
            [key]
        );

        if (rows.length > 0) {
            const value = rows[0].data;
            await this.setValueRedis(key, value);
            return value;
        }

        // Cache the ABSENCE too. Without this, a key with no row re-queries
        // Postgres on every read forever. Stored at the same key as a real
        // value would be, so setValue's write naturally overwrites it — no
        // separate invalidation path to keep in sync.
        try {
            await this.redis.set(key, MISS_SENTINEL, 'EX', MISS_TTL_SECONDS);
        } catch (err) {
            // A failed tombstone write is a performance regression, not a
            // correctness problem — the caller still gets the right answer.
            logger.warn(`[Database] Could not cache miss for ${key}: ${err.message}`);
        }

        return null;
    }

    async setValue(key, value) {
        const table = tableForKey(key);
        const res = await this.pg.query(
            `INSERT INTO ${table} (id, data) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [key, JSON.stringify(value)]
        );

        // Update the cache ONLY after the durable write succeeds. Writing Redis
        // first meant a failed Postgres write (which throws here) still left the
        // new value cached for the 6h TTL — so getValue would report a "saved"
        // value the caller had already been told failed (a "could not save"
        // message contradicted by the bot actually using the new value).
        await this.setValueRedis(key, value);

        return res.rowCount > 0;
    }

    async setValueRedis(key, value) {
        await this.redis.set(key, JSON.stringify(value), 'EX', this.expiry);
    }

    async deleteValue(key) {
        const table = tableForKey(key);
        const res = await this.pg.query(
            `DELETE FROM ${table} WHERE id = $1`,
            [key]
        );

        if (res.rowCount > 0) {
            await this.redis.del(key);
            return true;
        }

        return false;
    }

    async flushRedis() {
        // Scoped flush over only the bot's own key prefixes — never flushall(),
        // which wipes the ENTIRE Redis instance (every key from any co-tenant).
        // Uses SCAN (cursor-based, non-blocking) rather than KEYS. The bot's
        // keyspace: user:/guild: records, ratelimit: counters, aichat: memory.
        const prefixes = ['user:', 'guild:', 'ratelimit:', 'aichat:'];
        let deleted = 0;
        try {
            for (const prefix of prefixes) {
                let cursor = '0';
                do {
                    const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
                    cursor = next;
                    if (keys.length) {
                        await this.redis.del(...keys);
                        deleted += keys.length;
                    }
                } while (cursor !== '0');
            }
            logger.info(`[Reset] Redis scoped flush — deleted ${deleted} bot keys`);
            return true;
        } catch (error) {
            logger.error('[Error] Error during scoped Redis flush:', error);
            return false;
        }
    }

    // --- AI chat memory (Redis only; no Postgres persistence by design) -----
    // Caller builds the full scope key. Format conventions:
    //   dm:<userId>                — DM conversation (always per-user)
    //   <guildId>:ch:<channelId>   — shared per-channel thread (multiplayer)
    //   <guildId>:usr:<userId>     — private per-user thread in a guild
    // Distinct prefixes ensure no collision between modes. Short TTL + hard
    // cap on turns bound context cost. Intentionally Redis-only: if Redis
    // is down, users lose chat history but not guild/user profile config.
    chatMemoryKey(scope) {
        return `aichat:${scope}`;
    }

    async getChatMemory(scope) {
        try {
            const raw = await this.redis.get(this.chatMemoryKey(scope));
            return raw ? JSON.parse(raw) : [];
        } catch (err) {
            logger.error(`[ChatMemory] Read failed for ${scope}: ${err.message}`);
            return [];
        }
    }

    async appendChatMemory(scope, userMessage, assistantMessage, { ttlSeconds = 3600, maxTurns = 10 } = {}) {
        try {
            const existing = await this.getChatMemory(scope);
            existing.push({ role: 'user', content: userMessage });
            existing.push({ role: 'assistant', content: assistantMessage });
            // Keep only the last maxTurns pairs (user+assistant = 2 entries each).
            const trimmed = existing.slice(-maxTurns * 2);
            await this.redis.set(this.chatMemoryKey(scope), JSON.stringify(trimmed), 'EX', ttlSeconds);
            return true;
        } catch (err) {
            logger.error(`[ChatMemory] Append failed for ${scope}: ${err.message}`);
            return false;
        }
    }

    // --- AI chat source attribution (Redis only) -----------------------------
    // Records which grounded sources produced a given AI answer, keyed by the
    // MESSAGE ID of the answer itself. The [Sources] button on that message can
    // then look them up with no state encoded in the customId (which is capped
    // at 100 chars and could never hold a source list).
    //
    // Redis-only and TTL-bounded by design: this is provenance for a
    // conversation, not durable record-keeping. A week is long enough that
    // clicking Sources on yesterday's answer still works, short enough that the
    // keyspace stays bounded without eviction pressure.
    chatSourcesKey(messageId) {
        return `aichat:src:${messageId}`;
    }

    async setChatSources(messageId, payload, ttlSeconds = 604800) {
        try {
            await this.redis.set(this.chatSourcesKey(messageId), JSON.stringify(payload), 'EX', ttlSeconds);
            return true;
        } catch (err) {
            // Never throw into the reply path — losing provenance is much less
            // bad than failing to answer the user.
            logger.error(`[ChatSources] Write failed for ${messageId}: ${err.message}`);
            return false;
        }
    }

    async getChatSources(messageId) {
        try {
            const raw = await this.redis.get(this.chatSourcesKey(messageId));
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            logger.error(`[ChatSources] Read failed for ${messageId}: ${err.message}`);
            return null;
        }
    }

    async clearChatMemory(scope) {
        try {
            return await this.redis.del(this.chatMemoryKey(scope));
        } catch (err) {
            logger.error(`[ChatMemory] Clear failed for ${scope}: ${err.message}`);
            return 0;
        }
    }

    async close() {
        if (this.poolMonitor) {
            clearInterval(this.poolMonitor);
            this.poolMonitor = null;
        }
        await this.redis.quit();
        await this.pg.end();
        logger.info('[Database] Disconnected from Redis and Postgres');
    }
}

export default DatabaseHandler;
