require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const { postgresConfig } = require('./config.js'); // Import config
const DatabaseHandler = require('./database/redisPGHandler.js'); // Renamed variable
const logger = require('./utils/logger.js');
const setupAxiosInterceptors = require('./utils/axiosInterceptors');

// Wrap main logic in an async function to allow top-level await
async function startBot() {
    // Helper function to load modules (commands, events, buttons)
    function loadModules(client, directory, requiredProperties, registerModule, database = null) {
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
                const module = require(filePath);
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

    const database = new DatabaseHandler(postgresConfig)

    // Initialize database connection asynchronously
    try {
        await database.initialize();
    } catch (error) {
        logger.error('Failed to initialize database:', error);
        process.exit(1); // Exit if database connection fails
    }

    const client = new Client({
        intents: [GatewayIntentBits.Guilds],
        partials: [Partials.Channel],
    });

    client.commands = new Collection(); 
    client.buttons = new Collection();
    client.cooldowns = new Collection(); // A timeout for users to prevent spamming commands

    // Load Events
    loadModules(
        client,
        'events',
        ['name', 'execute'],
        (client, event, fileName, db) => {
            const register = (...args) => event.execute(...args, db); // Pass database to event handlers that need it
            if (event.once) {
                client.once(event.name, register);
            } else {
                client.on(event.name, register);
            }
            // Note: We don't log every loaded event by default anymore, adjust if needed.
            // logger.debug(`[Event] Loaded ${event.name}`);
        },
        database // Pass the database instance specifically for events
    );

    // Load Commands
    loadModules(
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
    loadModules(
        client,
        path.join('components', 'buttons'), // Handle nested path
        ['id', 'execute'],
        (client, button) => {
            client.buttons.set(button.id, button);
            logger.debug(`[Button] Loaded ${button.id}`);
        }
    );

    // Call the setup function for Axios interceptors
    setupAxiosInterceptors();

    // Log in to Discord with your client's token
    try {
        await client.login(process.env.DISCORDTOKEN);
        logger.info('[Bot] Client logged in successfully.');
    } catch (error) {
        logger.error('Failed to log in to Discord:', error);
        process.exit(1);
    }
}

// Start the bot
startBot();

