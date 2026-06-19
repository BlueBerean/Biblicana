import {
    SlashCommandBuilder,
    TextDisplayBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { renderVerseOfTheDay } from '../utils/dailyVerseRenderer.js';
import logger from '../utils/logger.js';
import { coerceTranslation } from '../utils/bibleHelper.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('passageoftheday')
        .setDescription('Get the Bible passage selected for today')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show the passage in (defaults to BSB)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[PassageOfTheDay Command] Failed to get user preference: ${dbError}`);
            }
            translation = coerceTranslation(
                interaction.options.getString('translation') || translation
            );

            const components = await renderVerseOfTheDay({ translation });
            if (!components) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't load today's passage. The schedule entry, verse text, or translation may be missing.`
                    )]
                });
            }

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components,
            });
        } catch (error) {
            logger.error(`[PassageOfTheDay Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, there was an unexpected error processing your request.`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[PassageOfTheDay Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
