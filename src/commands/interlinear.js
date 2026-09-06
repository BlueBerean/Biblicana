import {
    SlashCommandBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { coerceTranslation } from '../utils/bibleHelper.js';
import { numbersToBook, getBookId } from '../utils/bookNames.js';
import { resolveSingleChapterRef } from '../utils/scriptureRefs.js';
import {
    fetchInterlinearData,
    computeInterlinearPagination,
    buildInterlinearPage,
    setupInterlinearPagination
} from '../utils/interlinearRenderer.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('interlinear')
        .setDescription('Get an interlinear view of a specific Bible verse')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Book name or abbreviation (e.g., gen, john, 1co)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('Chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('Verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Parallel translation (defaults to your preference or BSB)')
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
        const rawBookInput = interaction.options.getString('book').trim();
        const chapterInput = interaction.options.getString('chapter');
        let verseInput = interaction.options.getNumber('verse');
        const rawBook = swearWordFilter(rawBookInput);

        let chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Invalid chapter number provided.', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);
        if (!bookId || !bookName) {
            logger.warn(`[Interlinear Command] Invalid book: ${rawBook}`);
            return interaction.reply({
                content: `Invalid book: "${rawBook}". Use names like Genesis, John, 1 Corinthians, or abbreviations like gen, jn, 1co.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // "book:Jude chapter:5" means Jude 1:5 - Jude has only one chapter.
        ({ chapter, startVerse: verseInput } = resolveSingleChapterRef(bookId, chapter, verseInput));

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Interlinear Command] Failed to get user preference: ${dbError}`);
            }
            translation = coerceTranslation(
                interaction.options.getString('translation') || translation
            );

            logger.info(`[Interlinear Command] Request: ${bookName} ${chapter}:${verseInput} (${translation})`);

            const data = await fetchInterlinearData({ bookId, chapter, verse: verseInput, translation });
            const { wordsPerPage, totalPages } = computeInterlinearPagination(data.strongsRecords.length);
            const flags = MessageFlags.IsComponentsV2;

            logger.info(`[Interlinear Command] Rendering V2 response for ${bookName} ${chapter}:${verseInput} — ${data.strongsRecords.length} Strong's entries across ${totalPages} page(s).`);

            await interaction.editReply({
                flags,
                components: buildInterlinearPage({ data, pageIdx: 0, wordsPerPage, totalPages })
            });

            await setupInterlinearPagination({ interaction, data, totalPages, wordsPerPage, flags });
        } catch (error) {
            logger.error(`[Interlinear Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [{ type: 10, content: `❌ ${error.message || 'An unexpected error occurred. Please try again later.'}` }]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Interlinear Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
