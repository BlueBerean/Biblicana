import pg from 'pg';
import Redis from 'ioredis';
import axios from 'axios';
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

class RedisPGClient {
    constructor(postgresConfig, redisConfig = null, redisExpiry = 21600) {
        this.pgClient = new pg.Pool(postgresConfig);
        this.redisClient = new Redis(redisConfig);

        this.rapidApiKey = process.env.RAPIDAPIKEY;
        this.rapidApiHost = 'uncovered-treasure-v1.p.rapidapi.com';

        this.redisClient.on('connect', () => {
            logger.debug('[Database] Connected to Redis');
        });

        this.expiry = redisExpiry;
    }

    async initialize() {
        logger.debug('[Database] Initializing Database Handler...');
        await this.createTables();
        logger.info('[Database] Database Handler Initialized.');
    }

    async createTables() {
        try {
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
        } catch (error) {
            logger.error(`[Database ERR] Error creating tables: ${error}`);
        }
    }

    async getStrongsDefinition(language, strongsId) {
        try {
            const options = {
                method: 'GET',
                url: `https://${this.rapidApiHost}/strongs/${strongsId}`,
                headers: {
                    'x-rapidapi-key': this.rapidApiKey,
                    'x-rapidapi-host': this.rapidApiHost
                }
            };

            const response = await axios.request(options);
            logger.debug('[API Response]', response.data);

            if (!response.data) {
                logger.error('[Error] No data in API response');
                return null;
            }

            if (!response.data.language) {
                logger.error('[Error] Response missing language property:', response.data);
                return null;
            }

            if (language && response.data.language.toLowerCase() !== language.toLowerCase()) {
                return null;
            }
            return response.data;
        } catch (error) {
            logger.error(`[Error] Failed to fetch Strong's definition:`, error.response?.data || error);
            return null;
        }
    }

    async searchStrongsByEnglish(language, word) {
        try {
            const options = {
                method: 'GET',
                url: `https://${this.rapidApiHost}/search/${encodeURIComponent(word)}`,
                headers: {
                    'x-rapidapi-key': this.rapidApiKey,
                    'x-rapidapi-host': this.rapidApiHost
                }
            };

            const response = await axios.request(options);
            logger.debug('[API Response]', response.data);

            if (!response.data) {
                logger.error('[Error] No data in API response');
                return null;
            }

            if (!response.data.results) {
                logger.error('[Error] Response missing results property:', response.data);
                return null;
            }

            if (language) {
                return response.data.results.filter(entry =>
                    entry.language && entry.language.toLowerCase() === language.toLowerCase()
                );
            }
            return response.data.results;
        } catch (error) {
            logger.error(`[Error] Failed to search Strong's concordance:`, error.response?.data || error);
            return null;
        }
    }

    async getValue(key) {
        const cachedValue = await this.redisClient.get(key);
        if (cachedValue) {
            return JSON.parse(cachedValue);
        }

        const query = `SELECT * FROM ${key.split(':')[0]}data WHERE id = $1`;
        const { rows } = await this.pgClient.query(query, [key]);

        if (rows.length > 0) {
            const value = rows[0].data;
            await this.setValueRedis(key, value);
            return value;
        }

        return null;
    }

    async setValue(key, value) {
        await this.setValueRedis(key, value);

        const query = `INSERT INTO ${key.split(':')[0]}data (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = '${JSON.stringify(value)}'`;

        const res = await this.pgClient.query(query, [key, JSON.stringify(value)]);

        if (res.rowCount > 0) {
            return true;
        }

        return false;
    }

    async setValueRedis(key, value) {
        await this.redisClient.set(key, JSON.stringify(value));
        this.redisClient.expire(key, this.expiry);
    }

    async deleteValue(key) {
        const query = `DELETE FROM ${key.split(':')[0]}data WHERE id = $1`;
        const res = await this.pgClient.query(query, [key]);

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
