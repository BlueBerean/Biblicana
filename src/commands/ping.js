import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Checks the bot\'s latency.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),
    async execute(interaction) {
        try {
            const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });

            const wsPing = interaction.client.ws.ping;
            const apiLatency = sent.createdTimestamp - interaction.createdTimestamp;

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
            const embed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle('🏓 Pong!')
                .addFields(
                    { name: 'WebSocket Ping', value: `~${wsPing}ms`, inline: true },
                    { name: 'API Latency', value: `~${apiLatency}ms`, inline: true }
                )
                .setTimestamp();

            await interaction.editReply({ content: null, embeds: [embed] });
        } catch (error) {
            logger.error(`[Ping Command] Error: ${error.message}`);
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: 'Could not measure ping due to an error.', flags: MessageFlags.Ephemeral });
                } else {
                    await interaction.reply({ content: 'Could not measure ping due to an error.', flags: MessageFlags.Ephemeral });
                }
            } catch (replyError) {
                logger.error(`[Ping Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};
