const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
require('dotenv').config();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Checks the bot\'s latency.'),
    async execute(interaction) {
        try {
            // Send initial reply and measure time
            const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });

            const wsPing = interaction.client.ws.ping;
            const apiLatency = sent.createdTimestamp - interaction.createdTimestamp;

            // Use an embed for cleaner presentation
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
            const embed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle('🏓 Pong!')
                .addFields(
                    { name: 'WebSocket Ping', value: `~${wsPing}ms`, inline: true },
                    { name: 'API Latency', value: `~${apiLatency}ms`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ content: null, embeds: [embed] }); // Edit the original reply
        } catch (error) {
            logger.error(`[Ping Command] Error: ${error.message}`);
            // Try to reply if possible, otherwise log
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'Could not measure ping due to an error.', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'Could not measure ping due to an error.', ephemeral: true });
                }
            } catch (replyError) {
                logger.error(`[Ping Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};