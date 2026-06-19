import pg from 'pg';
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import userModel from './schemas/user.js';
import guildModel from './schemas/guild.js';

// Only these key prefixes may map to Postgres tables. Guards against both SQL
// injection via crafted keys and silent typos that would hit a nonexistent table.
const ALLOWED_TABLE_PREFIXES = new Set(['user', 'guild']);

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

        this.redis.on('connect', () => {
            logger.debug('[Database] Connected to Redis');
        });
    }

    async initialize() {
        logger.debug('[Database] Initializing Database Handler...');
        await this.createTables();
        // Probe that the pool can actually execute queries — createTables can
        // succeed against a cached schema while the session is unusable.
        await this.pg.query('SELECT 1');
        logger.info('[Database] Database Handler Initialized.');
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

    // Fixed-window rate limit on a (scope, userId) pair. Returns
    // { allowed, count, retryAfterSeconds }. Fails open on Redis errors so
    // a Redis blip doesn't brick paid commands for every user at once.
    async checkRateLimit(scope, userId, { limit, windowSeconds }) {
        // Dev bypass: DISABLE_RATE_LIMITS=1 short-circuits every rate-limited
        // command (aichat, find, web, etc.) without touching Redis. Loud
        // startup warning in index.js surfaces when this is on. NEVER set
        // this in production — it opens the bot to abusive usage and could
        // run up significant OpenAI/Tavily bills.
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
        if (cachedValue) {
            return JSON.parse(cachedValue);
        }

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

        return null;
    }

    async setValue(key, value) {
        await this.setValueRedis(key, value);

        const table = tableForKey(key);
        const res = await this.pg.query(
            `INSERT INTO ${table} (id, data) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [key, JSON.stringify(value)]
        );

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
        try {
            await this.redis.flushall();
            logger.info('[Reset] Redis client reset');
            return true;
        } catch (error) {
            logger.error('[Error] Error resetting Redis client:', error);
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

    async clearChatMemory(scope) {
        try {
            return await this.redis.del(this.chatMemoryKey(scope));
        } catch (err) {
            logger.error(`[ChatMemory] Clear failed for ${scope}: ${err.message}`);
            return 0;
        }
    }

    async close() {
        await this.redis.quit();
        await this.pg.end();
        logger.info('[Database] Disconnected from Redis and Postgres');
    }
}

export default DatabaseHandler;
