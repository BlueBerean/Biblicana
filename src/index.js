import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, Collection, Events, GatewayIntentBits, Partials } from 'discord.js';
import { postgresConfig } from './config.js';
import DatabaseHandler from './database/redisPGHandler.js';
import logger from './utils/logger.js';
import setupAxiosInterceptors from './utils/axiosInterceptors.js';
import { startDailyVerseScheduler } from './utils/dailyVerseScheduler.js';

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
        intents: [
            GatewayIntentBits.Guilds,
            // MessageContent is privileged; enabled for passive scripture
            // detection in messageCreate. Already approved for this app on
            // both dev and prod (post-verification). Do not enable
            // GuildMembers or GuildPresences unless a concrete feature needs
            // them — they get higher scrutiny from Discord.
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
            // DirectMessages: the AI-chat path treats a DM to the bot as a
            // first-class trigger (see shouldAiFire / handleAiChat). Without
            // this intent MessageCreate never fires for DMs, so the advertised
            // "DM Biblicana directly" flow is silently dead. Pairs with
            // Partials.Channel below (DM channels arrive uncached).
            GatewayIntentBits.DirectMessages,
        ],
        partials: [
            Partials.Channel,
            // Without Partials.Message and Partials.Reaction, reactionAdd
            // silently doesn't fire for messages the bot didn't see posted
            // (e.g., bot restart + someone reacts to an older message).
            // One of the most common "reactions don't work sometimes" bugs.
            Partials.Message,
            Partials.Reaction,
        ],
    });

    client.commands = new Collection();
    client.buttons = new Collection();
    client.selects = new Collection();

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

    // Load Select Menus. Persistent select-menu handlers live here (as opposed
    // to ephemeral inline collectors used inside single-command flows like
    // /commentary's commentator-switcher). Needed for any UI that outlives the
    // command invocation — notably the passive-mode selector in the guildCreate
    // welcome card, which must still work after the bot restarts.
    await loadModules(
        client,
        path.join('components', 'selects'),
        ['id', 'execute'],
        (client, select) => {
            client.selects.set(select.id, select);
            logger.debug(`[Select] Loaded ${select.id}`);
        }
    );

    setupAxiosInterceptors();

    // PM2 sends SIGINT on `pm2 restart` and SIGTERM on `pm2 stop`. Close the
    // Discord gateway and drain the Postgres pool / Redis connection before
    // exiting so restarts don't leak sessions or half-written Redis state.
    let shuttingDown = false;
    const shutdown = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info(`[Bot] ${signal} received — shutting down gracefully.`);
        if (dailyVerseHandle) {
            try { clearInterval(dailyVerseHandle); } catch { /* noop */ }
        }
        try {
            client.destroy();
        } catch (err) {
            logger.error(`[Bot] Error during client.destroy(): ${err.message}`);
        }
        try {
            await database.close();
        } catch (err) {
            logger.error(`[Bot] Error during database.close(): ${err.message}`);
        }
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Last-resort safety net: an unhandled promise rejection terminates the
    // Node process (Node 18+), which under PM2 means a restart cycle hitting all
    // ~512 servers at once. A single transient DB/Discord blip in any handler
    // that forgot a catch shouldn't take the bot down — log it and stay up.
    process.on('unhandledRejection', (reason) => {
        logger.error(`[Bot] Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
    });

    // Loud startup warnings for dev bypass flags. These should never be set
    // in production; if they are, flooding the logs makes that obvious.
    if (process.env.DISABLE_RATE_LIMITS) {
        logger.warn('[Bot] ⚠️  DISABLE_RATE_LIMITS=1 — ALL rate limits BYPASSED (aichat, find, web). Dev only, DO NOT ship to prod.');
    }
    if (process.env.DEBUG_AICHAT_RAG) {
        logger.warn('[Bot] ⚠️  DEBUG_AICHAT_RAG=1 — Full RAG prompt bodies are logged on every AI chat. Dev only.');
    }

    // Start the daily verse scheduler only after the bot's guild cache is
    // populated — otherwise the first tick would iterate an empty cache
    // and miss posts due right at startup. Events.ClientReady fires once
    // after Discord sends the READY packet with the guild list.
    let dailyVerseHandle = null;
    client.once(Events.ClientReady, () => {
        dailyVerseHandle = startDailyVerseScheduler(client, database);
    });

    try {
        await client.login(process.env.DISCORDTOKEN);
        logger.info('[Bot] Client logged in successfully.');
    } catch (error) {
        logger.error('Failed to log in to Discord:', error);
        process.exit(1);
    }
}

startBot();
