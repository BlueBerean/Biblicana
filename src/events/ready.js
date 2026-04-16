import { Events, ActivityType } from 'discord.js';
import logger from '../utils/logger.js';

function setPresence(client) {
    client.user.setPresence({
        status: 'online',
        activities: [{
            name: `with ${client.guilds.cache.size} servers!`,
            type: ActivityType.Playing
        }],
    });
}

export default {
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
