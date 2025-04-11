const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
require('dotenv').config();

// Helper function to format uptime
function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    let uptimeString = '';
    if (days > 0) uptimeString += `${days}d `;
    if (hours > 0) uptimeString += `${hours}h `;
    if (minutes > 0) uptimeString += `${minutes}m `;
    uptimeString += `${seconds}s`;

    return uptimeString.trim() || '0s'; // Return '0s' if uptime is very short
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Displays bot and server statistics.'),
    async execute(interaction) {
        try {
            const client = interaction.client; // For easier access

            // Basic stats
            const wsPing = client.ws.ping;
            const uptime = formatUptime(client.uptime);
            const memoryUsage = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);

            // Shard/Guild/User counts (Note: These might be for the current shard only if sharded)
            const shardCount = client.ws.shards?.size || 1; // Default to 1 if not sharded
            const guildCount = client.guilds.cache.size;
            // User count can be less accurate due to caching policies
            const userCount = client.users.cache.size; // This counts cached users bot has seen

            // Use parseInt for safer color handling, provide a default
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle('📊 Bot Statistics')
                .setColor(embedColor)
                .setURL(process.env.WEBSITE) // Optional
                .setDescription(`Here are the current stats for ${client.user.username}:`)
                .addFields(
                    { name: '💓 Ping', value: `~${wsPing}ms`, inline: true },
                    { name: '✅ Uptime', value: uptime, inline: true },
                    { name: '💾 Memory', value: `${memoryUsage} MB`, inline: true },
                    { name: '🌐 Guilds', value: guildCount.toString(), inline: true },
                    { name: '👤 Cached Users', value: userCount.toString(), inline: true },
                    { name: '🧩 Shards', value: shardCount.toString(), inline: true }
                    // Note: Guild/User count might be inaccurate if the bot is sharded.
                    // A more accurate method uses client.shard.broadcastEval() but is more complex.
                )
                .setTimestamp() // Add timestamp
                .setFooter({
                    text: process.env.EMBEDFOOTERTEXT,
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed] });

        } catch (error) {
            logger.error(`[Stats Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.reply({
                    content: '❌ Sorry, there was an error fetching the stats.',
                    ephemeral: true
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) { // Avoid logging common expired interaction errors
                    logger.error(`[Stats Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
}