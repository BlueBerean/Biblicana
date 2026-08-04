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
            // withResponse replaces the deprecated `fetchReply: true` reply
            // OPTION, which emitted a warning on every /ping. Note this is the
            // option that was deprecated, not the standalone
            // interaction.fetchReply() method used elsewhere in the codebase —
            // that one is still current.
            const response = await interaction.reply({ content: 'Pinging...', withResponse: true });

            // Fall back rather than throw: this command exists to report
            // latency, and the WebSocket ping below is still measurable even if
            // the callback resource is missing.
            const sent = response?.resource?.message ?? await interaction.fetchReply();

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
