const pg = require('pg');
const Redis = require('ioredis');
const logger = require('../utils/logger.js');
const userModel = require('./schemas/user.js');
const guildModel = require('./schemas/guild.js');

/**
 * This is a wrapper for the RedisPGClient class, it is used to make it easier to use the RedisPGClient class
 * @param {Object} postgresConfig - The postgres configuration
 * @param {Object} redisConfig - The redis configuration (optional)
 * @param {Number} redisExpiry - The expiry time for redis keys (optional)
 * 
*/
class RedisPGWrapper {
    constructor(postgresConfig, redisConfig, redisExpiry) {
        this.RedisPGClient = new RedisPGClient(postgresConfig, redisConfig, redisExpiry);
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

    /**
     * 
     * @param {*} key  The key to use, use this format: "user:1"
     * @param {} value  The value to set
     * @param {} schema  The schema to use to validate the value
     * @returns {Boolean} - Returns true if the value was set, false if it wasn't
    */
    async updateValue(key, value, schema) {
        const originalValue = await this.RedisPGClient.getValue(key);

        if (!originalValue) {
            logger.error(`[Error] Key ${key} not found`);
            return false;
        }

        const replacedValue = this.fillProperties(originalValue, value);

        return this.validateAndSetValue(key, replacedValue, schema);
    }

    /**
     * Use this function to validate and set a value in the database
     * @param {String} key - The key to use, use this format: "user:1"
     * @param {Object} value - The value to set
     * @param {Object} schema - The schema to use to validate the value
     * @returns {Boolean} - Returns true if the value was set, false if it wasn't
     * 
    */
    async validateAndSetValue(key, value, schema) {
        const { error } = schema.validate(value); // Validate, if there is not error, update the value

        if (error) {
            logger.error('[Error] Error validating user:', error);
            return false;
        }

        // If the value is valid, it will always have a id property
        return this.RedisPGClient.setValue(key, value);
    }

    /**
     * This is a helper function to fill properties in an object
     * @param {Object} originalValue - The original object
     * @param {Object} newValue - The new object    
     * @returns {Object} - Returns the original object with the new properties
     * @example
     * const originalValue = { id: "1", name: "test" };
     * const newValue = { name: "test2" };
     * const filledObject = fillProperties(originalValue, newValue);
     * console.log(filledObject); // { id: "1", name: "test2" }
    */
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

        this.createTables();
        
        this.redisClient = new Redis(redisConfig);

        this.redisClient.on('connect', () => {
            logger.debug('[Database] Connected to Redis');
        });

        this.expiry = redisExpiry;
        
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

    // Generic functions
    /**
     * Use this function to get a value from the database
     * @param {String} key - The key to use, use this format: "user:1"
     * @returns {Object} - Returns the value if it exists, null if it doesn't
     * 
    */
    async getValue(key) {
        const cachedValue = await this.redisClient.get(key);
        if (cachedValue) {
            return JSON.parse(cachedValue);
        }

        const query = `SELECT * FROM ${key.split(':')[0]}data WHERE id = $1`; // Key is in the format "user:1", so we split it and get the first part
        const { rows } = await this.pgClient.query(query, [key]);

        if (rows.length > 0) {
            const value = rows[0].data;
            await this.setValueRedis(key, value);
            return value;
        }

        return null;
    }

    /**
     * Use this function to set a value in the database
     * @param {Object} value - The value to set
     * @param {String} key - The key to use, use this format: "user:1"
     * @returns {Boolean} - Returns true if the value was set, false if it wasn't
    */
    async setValue(key, value) {
        await this.setValueRedis(key, value);

        const query = `INSERT INTO ${key.split(':')[0]}data (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = '${JSON.stringify(value)}'`;

        const res = await this.pgClient.query(query, [key, JSON.stringify(value)]);

        if (res.rowCount > 0) {
            return true;
        }

        return false;
    }

    /** 
    * Use this function to set a value in the redis database
    * @param {Object} value - The value to set
    * @param {String} key - The key to use, use this format: "user:1"
    */
    async setValueRedis(key, value) {
        await this.redisClient.set(key, JSON.stringify(value))

        this.redisClient.expire(key, this.expiry);
    }

    /**
     * Use this function to delete a value from the redis database and the postgres database
     * @param {String} key - The key to use, use this format: "user:1"
     * @returns {Boolean} - Returns true if the value was deleted, false if it wasn't
     */
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

module.exports = RedisPGWrapper;
