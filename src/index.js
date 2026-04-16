import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { postgresConfig } from './config.js';
import DatabaseHandler from './database/redisPGHandler.js';
import logger from './utils/logger.js';
import setupAxiosInterceptors from './utils/axiosInterceptors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startBot() {
    // Helper to dynamically load modules (commands, events, buttons) via ESM import().
    // Each module file is expected to `export default { ... }`; we unwrap `.default` after import.
    async function loadModules(client, directory, requiredProperties, registerModule, database = null) {
        const modulePath = path.join(__dirname, directory);
        let moduleFiles;
        try {
            moduleFiles = fs.readdirSync(modulePath).filter(file => file.endsWith('.js'));
        } catch (error) {
            logger.error(`Error reading directory ${modulePath}:`, error);
            return;
        }

        for (const file of moduleFiles) {
            const filePath = path.join(modulePath, file);
            try {
                const moduleExports = await import(pathToFileURL(filePath).href);
                const module = moduleExports.default;
                if (!module) {
                    logger.warn(`[WARNING] The module at ${file} has no default export.`);
                    continue;
                }
                const missingProps = requiredProperties.filter(prop => !module[prop]);

                if (missingProps.length > 0) {
                    logger.warn(`[WARNING] The module at ${file} is missing required properties: ${missingProps.join(', ')}`);
                    continue;
                }

                registerModule(client, module, file, database);
            } catch (error) {
                logger.error(`Error loading module at ${filePath}:`, error);
            }
        }
    }

    const database = new DatabaseHandler(postgresConfig);

    try {
        await database.initialize();
    } catch (error) {
        logger.error('Failed to initialize database:', error);
        process.exit(1);
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
        partials: [Partials.Channel],
    });

    client.commands = new Collection();
    client.buttons = new Collection();
    client.cooldowns = new Collection();

    // Load Events
    await loadModules(
        client,
        'events',
        ['name', 'execute'],
        (client, event, fileName, db) => {
            const register = (...args) => event.execute(...args, db);
            if (event.once) {
                client.once(event.name, register);
            } else {
                client.on(event.name, register);
            }
        },
        database
    );

    // Load Commands
    await loadModules(
        client,
        'commands',
        ['data', 'execute'],
        (client, command, fileName) => {
            if (command.data.name) {
                client.commands.set(command.data.name, command);
                logger.debug(`[Command] Loaded ${command.data.name}`);
            } else {
                logger.warn(`[WARNING] The command at ${fileName} has 'data' but is missing a 'name' property.`);
            }
        }
    );

    // Load Buttons
    await loadModules(
        client,
        path.join('components', 'buttons'),
        ['id', 'execute'],
        (client, button) => {
            client.buttons.set(button.id, button);
            logger.debug(`[Button] Loaded ${button.id}`);
        }
    );

    setupAxiosInterceptors();

    try {
        await client.login(process.env.DISCORDTOKEN);
        logger.info('[Bot] Client logged in successfully.');
    } catch (error) {
        logger.error('Failed to log in to Discord:', error);
        process.exit(1);
    }
}

startBot();
