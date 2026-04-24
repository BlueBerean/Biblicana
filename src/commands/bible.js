import {
    SlashCommandBuilder,
    TextDisplayBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { getBookId, coerceTranslation } from '../utils/bibleHelper.js';
import { fetchBibleVerseData, buildBibleComponents } from '../utils/bibleRenderer.js';
import logger from '../utils/logger.js';

export default {
    data: new SlashCommandBuilder()
        .setName('bible')
        .setDescription('Find a specific verse in the bible')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option => option.setName('book').setDescription('The book you want to find a verse for').setRequired(true))
        .addStringOption(option => option.setName('chapter').setDescription('The chapter you want to find a verse for').setRequired(true))
        .addNumberOption(option => option.setName('startverse').setDescription('The range of verses you want to find').setRequired(true))
        .addNumberOption(option => option.setName('endverse').setDescription('The range of verses you want to find'))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        const rawBook = interaction.options.getString('book').split(" ").join("");
        const bookId = getBookId(rawBook);

        if (!bookId) {
            logger.warn(`[Bible Command] Could not find book ID for: ${rawBook}`);
            return interaction.reply({
                content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const chapter = interaction.options.getString('chapter');
        const startVerse = interaction.options.getNumber('startverse');
        const endVerse = interaction.options.getNumber('endverse') || startVerse;

        if (startVerse > endVerse) {
            return interaction.reply({
                content: 'The start verse cannot be greater than the end verse.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = coerceTranslation(
                interaction.options.getString('translation') || defaultTranslation?.translation
            );

            logger.info(`[Bible Command] Looking up ${bookId} ${chapter}:${startVerse}-${endVerse} in ${translation}`);

            const data = await fetchBibleVerseData({ bookId, chapter, startVerse, endVerse, translation });
            if (!data) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No verse text available for this reference in ${translation.toUpperCase()}.`)]
                });
            }

            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildBibleComponents({ data, includeActionRow: true })
            });
        } catch (error) {
            logger.error(`[Bible Command] Error processing request: ${error.message}`, error.stack);
            try {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, there was an error processing your request.`)]
                });
            } catch (e) {
                logger.error(`[Bible Command] Could not send error message: ${e.message}`);
            }
        }
    },
};
