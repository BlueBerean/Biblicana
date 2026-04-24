import {
    SlashCommandBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
    TextDisplayBuilder
} from 'discord.js';
import { getBookId, coerceTranslation } from '../utils/bibleHelper.js';
import { fetchRandomVerseData, buildRandomVerseComponents } from '../utils/randomVerseRenderer.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('randomverse')
        .setDescription('Get a random Bible verse')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Limit to a specific book (optional)')
                .setRequired(false))
        .addNumberOption(option =>
            option.setName('chapter')
                .setDescription('Limit to a specific chapter (requires book)')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Translation to display (defaults to your preference or BSB)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        const rawBookInput = interaction.options.getString('book');
        const chapterInput = interaction.options.getNumber('chapter');

        let filterBookId = null;
        if (rawBookInput) {
            const rawBook = swearWordFilter(rawBookInput.trim());
            if (rawBook) {
                filterBookId = getBookId(rawBook);
                if (!filterBookId) {
                    return interaction.reply({
                        content: `I couldn't find the book "${rawBookInput}". Please check the spelling or try using the full book name.`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }
        }

        const filterChapter = chapterInput && filterBookId ? chapterInput : null;
        if (chapterInput && !filterBookId) {
            return interaction.reply({
                content: 'Chapter filter requires a book to be specified.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let preferredTranslation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) preferredTranslation = userPref.translation;
            } catch (dbError) {
                logger.error(`[RandomVerse Command] Failed to get user preference: ${dbError}`);
            }
            preferredTranslation = coerceTranslation(
                interaction.options.getString('translation') || preferredTranslation
            );

            const data = await fetchRandomVerseData({ filterBookId, filterChapter, preferredTranslation });
            if (!data) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No verses found matching the specified filter.`)]
                });
            }

            logger.info(`[RandomVerse Command] Displaying: ${data.bookName} ${data.chapter}:${data.verse} (${data.translation})`);

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildRandomVerseComponents({ data, filterBookId, filterChapter })
            });
        } catch (error) {
            logger.error(`[RandomVerse Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ ${error.message || 'An unexpected error occurred.'}`)]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[RandomVerse Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
