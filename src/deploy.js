const fs = require('fs');
require('dotenv').config();
const { Routes, REST } = require('discord.js');
const logger = require('./utils/logger.js');
const args = process.argv.slice(2);

const commands = [];
// Grab all the command files from the commands directory you created earlier
const commandFiles = fs.readdirSync('src/commands').filter(file => file.endsWith('.js'));

// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    commands.push(command.data.toJSON());
}

// Construct and prepare an instance of the REST module
const rest = new REST({ version: '10' }).setToken(process.env.DISCORDTOKEN);

// and deploy your commands!
(async () => {
    try {
        // The put method is used to fully refresh all commands in the guild with the current set
        if (args.includes('--global')) {

            if (args.includes('--rm')) {
                await rest.put(
                    Routes.applicationCommands(process.env.CLIENTID),
                    { body: [] },
                );

                return logger.info(`Successfully removed application (/) commands in global scope.`);
            }

            await rest.put(
                Routes.applicationCommands(process.env.CLIENTID),
                { body: commands },
            );

            logger.info(`Successfully reloaded application (/) commands in global scope.`);
        } else {
            if (args.includes('--rm')) {
                await rest.put(
                    Routes.applicationGuildCommands(process.env.CLIENTID, process.env.GUILDID),
                    { body: [] },
                );

                return logger.info(`Successfully removed application (/) commands in local scope.`);
            }

            await rest.put(
                Routes.applicationGuildCommands(process.env.CLIENTID, process.env.GUILDID),
                { body: commands },
            );

            logger.info(`Successfully reloaded application (/) commands in local scope.`);
        }
    } catch (error) {
        // And of course, make sure you catch and log any errors!
        logger.error(error);
    }
})();