const { Client, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const redisPGHandler = require('./database/redisPGHandler.js');
const logger = require('./utils/logger.js');
require('dotenv').config()

const postgresConfig =  {
    "host": process.env.PGHOST,
    "user": process.env.PGUSER,
    "password": process.env.PGPASSWORD,
    "database": process.env.PGDATABASE,
    "ssl": {
        "sslmode": "require"
    }
}
const database = new redisPGHandler(postgresConfig) 

const client = new Client({
    intents: []
});

client.commands = new Collection(); 
client.buttons = new Collection();
client.cooldowns = new Collection(); // A timeout for users to prevent spamming commands

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(__dirname, 'events', file)
    const event = require(filePath);

    if (event.name && event.execute) {
        if (event.once) {
            client.once(event.name, (interaction) => {
                event.execute(interaction);
            });
        } else {
            client.on(event.name, (interaction) => {
                event.execute(interaction, database);
            });
        }
    } else {
        logger.warn(`[WARNING] The event at ${file} is missing a required "name" or "execute" property.`);
    }
}

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(__dirname, 'commands', file));
    if (command.data && command.execute) {
        client.commands.set(command.data.name, command);
        logger.debug(`[Command] Loaded ${command.data.name}`);
    } else {
        logger.warn(`[WARNING] The command at ${file} is missing a required "data" or "execute" property.`);
    }
}

const buttonsPath = path.join(__dirname, 'components', 'buttons');
const buttonFiles = fs.readdirSync(buttonsPath).filter(file => file.endsWith('.js'));

for (const file of buttonFiles) {
    const button = require(path.join(__dirname, 'components', 'buttons', file));

    if (button.id && button.execute) {
        client.buttons.set(button.id, button);
        logger.debug(`[Button] Loaded ${button.id}`);
    } else {
        logger.warn(`[WARNING] The button at ${file} is missing a required "id" or "execute" property.`);
    }
}

client.login(process.env.DISCORDTOKEN);

