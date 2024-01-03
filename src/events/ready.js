const { Events, ActivityType } = require('discord.js');
const logger = require('../utils/logger.js');
function setPresence(client) {
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: `with ${client.guilds.cache.size} servers!`,
            type: ActivityType.Playing
        }],
    });
}
module.exports = {
	name: Events.ClientReady,
	once: true,
    async execute(client) {
        logger.info(`[Discord] Logged in as ${client.user.tag}`);
        setPresence(client);

        setInterval(() => {
            setPresence(client);
        }, 3600000);

	},
};