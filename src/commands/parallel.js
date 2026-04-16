import {
    SlashCommandBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
    TextDisplayBuilder
} from 'discord.js';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import {
    fetchParallelData,
    packParallelPages,
    buildParallelPage,
    setupParallelPagination
} from '../utils/parallelRenderer.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('parallel')
        .setDescription('View a verse in multiple parallel Bible translations')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book name or abbreviation')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to list first (defaults to your saved preference)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        // Sync validation before defer — V1 ephemeral error if fails.
        const rawBookInput = interaction.options.getString('book').trim();
        const chapterInput = interaction.options.getString('chapter');
        const verseInput = interaction.options.getNumber('verse');
        const rawBook = swearWordFilter(rawBookInput);

        const chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Invalid chapter number provided.', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);
        if (!bookId || !bookName) {
            logger.warn(`[Parallel Command] Invalid book: ${rawBook}`);
            return interaction.reply({ content: `Invalid book: "${rawBook}".`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let primaryTranslation = null;
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) primaryTranslation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Parallel Command] Failed to get user preference: ${dbError}`);
            }
            primaryTranslation = interaction.options.getString('translation') || primaryTranslation;

            logger.info(`[Parallel Command] Request: ${bookName} ${chapter}:${verseInput} (first: ${primaryTranslation || 'default order'})`);

            const data = await fetchParallelData({ bookId, chapter, verse: verseInput, primaryTranslation });
            if (!data || data.lines.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No translations found for ${bookName} ${chapter}:${verseInput}.`)]
                });
            }

            const pages = packParallelPages(data.lines);
            const flags = MessageFlags.IsComponentsV2;

            logger.info(`[Parallel Command] Rendering ${data.lines.length} translations across ${pages.length} page(s).`);

            await interaction.editReply({
                flags,
                components: buildParallelPage({ data, pages, pageIdx: 0 })
            });

            await setupParallelPagination({ interaction, data, pages, flags });
        } catch (error) {
            logger.error(`[Parallel Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ ${error.message || 'An unexpected error occurred. Please try again later.'}`)]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Parallel Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
