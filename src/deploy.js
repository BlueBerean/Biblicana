const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { Routes, REST } = require('discord.js');
const logger = require('./utils/logger.js');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Setup yargs for argument parsing
const argv = yargs(hideBin(process.argv))
    .option('global', {
        alias: 'g',
        type: 'boolean',
        description: 'Deploy commands globally instead of to the development guild'
    })
    .option('rm', {
        alias: 'r',
        type: 'boolean',
        description: 'Remove all commands instead of deploying'
    })
    .help()
    .alias('help', 'h')
    .argv;

const commands = [];
// Use path.join for robustness
const commandsPath = path.join(__dirname, 'commands'); 
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if (command.data?.toJSON) {
            commands.push(command.data.toJSON());
        } else {
            logger.warn(`[WARNING] Command at ${file} is missing 'data' or 'data.toJSON' method.`);
        }
    } catch (error) {
        logger.error(`Error loading command at ${filePath}:`, error);
    }
}

// Construct and prepare an instance of the REST module
const rest = new REST({ version: '10' }).setToken(process.env.DISCORDTOKEN);

// and deploy your commands!
(async () => {
    try {
        const clientId = process.env.CLIENTID;
        const guildId = process.env.GUILDID;

        // Determine route based on --global flag
        const route = argv.global
            ? Routes.applicationCommands(clientId)
            : Routes.applicationGuildCommands(clientId, guildId);

        // Determine body based on --rm flag
        const body = argv.rm ? [] : commands;

        // Determine scope description for logging
        const scope = argv.global ? 'global' : 'local (guild)';
        const action = argv.rm ? 'removed' : 'reloaded';

        logger.info(`Attempting to ${action} ${body.length} application (/) commands in ${scope} scope...`);

        await rest.put(route, { body });

        logger.info(`Successfully ${action} application (/) commands in ${scope} scope.`);

    } catch (error) {
        // And of course, make sure you catch and log any errors!
        logger.error('Error during command deployment:', error);
    }
})();