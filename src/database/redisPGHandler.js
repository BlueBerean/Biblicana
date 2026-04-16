import pg from 'pg';
import Redis from 'ioredis';
import logger from '../utils/logger.js';
import userModel from './schemas/user.js';
import guildModel from './schemas/guild.js';

/**
 * Wrapper for RedisPGClient — unified Redis + Postgres interface.
 * @param {Object} postgresConfig - Postgres connection config
 * @param {Object} [redisConfig] - Redis connection config (optional)
 * @param {Number} [redisExpiry] - Redis key expiry seconds (optional)
 */
class RedisPGWrapper {
    constructor(postgresConfig, redisConfig, redisExpiry) {
        this.RedisPGClient = new RedisPGClient(postgresConfig, redisConfig, redisExpiry);
    }

    async initialize() {
        await this.RedisPGClient.initialize();
    }

    // User functions
    async setUserValue(id, value) {
        return this.validateAndSetValue(`user:${id}`, value, userModel);
    }

    async getUserValue(id) {
        return this.RedisPGClient.getValue(`user:${id}`);
    }

    async updateUserValue(id, value) {
        return this.updateValue(`user:${id}`, value, userModel);
    }

    async deleteUserValue(id) {
        return this.RedisPGClient.deleteValue(`user:${id}`);
    }

    // Guild functions
    async setGuildValue(id, value) {
        return this.validateAndSetValue(`guild:${id}`, value, guildModel);
    }

    async getGuildValue(id) {
        return this.RedisPGClient.getValue(`guild:${id}`);
    }

    async updateGuildValue(id, value) {
        return this.updateValue(`guild:${id}`, value, guildModel);
    }

    async deleteGuildValue(id) {
        return this.RedisPGClient.deleteValue(`guild:${id}`);
    }

    async updateValue(key, value, schema) {
        const originalValue = await this.RedisPGClient.getValue(key);

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

        return this.RedisPGClient.setValue(key, value);
    }

    fillProperties(originalValue, newValue) {
        let filledObject = originalValue;
        for (const key in newValue) {
            if (originalValue[key] === undefined) {
                logger.error(`[Error] Property ${key} does not exist in original value`);
                return false;
            }

            originalValue[key] = newValue[key];
        }

        return filledObject;
    }
}

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

class RedisPGClient {
    constructor(postgresConfig, redisConfig = null, redisExpiry = 21600) {
        this.pgClient = new pg.Pool(postgresConfig);
        this.redisClient = new Redis(redisConfig);

        this.redisClient.on('connect', () => {
            logger.debug('[Database] Connected to Redis');
        });

        this.expiry = redisExpiry;
    }

    async initialize() {
        logger.debug('[Database] Initializing Database Handler...');
        await this.createTables();
        // Probe that the pool can actually execute queries — createTables can
        // succeed against a cached schema while the session is unusable.
        await this.pgClient.query('SELECT 1');
        logger.info('[Database] Database Handler Initialized.');
    }

    async createTables() {
        await this.pgClient.query(`
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

    async getValue(key) {
        const cachedValue = await this.redisClient.get(key);
        if (cachedValue) {
            return JSON.parse(cachedValue);
        }

        const table = tableForKey(key);
        const { rows } = await this.pgClient.query(
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
        const res = await this.pgClient.query(
            `INSERT INTO ${table} (id, data) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
            [key, JSON.stringify(value)]
        );

        return res.rowCount > 0;
    }

    async setValueRedis(key, value) {
        await this.redisClient.set(key, JSON.stringify(value), 'EX', this.expiry);
    }

    async deleteValue(key) {
        const table = tableForKey(key);
        const res = await this.pgClient.query(
            `DELETE FROM ${table} WHERE id = $1`,
            [key]
        );

        if (res.rowCount > 0) {
            await this.redisClient.del(key);
            return true;
        }

        return false;
    }

    async flushRedis() {
        try {
            await this.redisClient.flushall();
            logger.info('[Reset] Redis client reset');
            return true;
        } catch (error) {
            logger.error('[Error] Error resetting Redis client:', error);
            return false;
        }
    }

    async close() {
        await this.redisClient.quit();
        await this.pgClient.end();
        logger.info('[Database] Disconnected from Redis and MongoDB');
    }
}

export default RedisPGWrapper;
