import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import { commentaryWrapper, toCommentaryBookCodes, COMMENTATORS } from '../utils/studyHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 4000;
const COLLECTOR_TIMEOUT_MS = 1_800_000;
const DEFAULT_COMMENTATOR_ID = 'jamieson-fausset-brown';

function generateFooter(commentatorLabel, page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | ${commentatorLabel}${pageText}`,
        iconURL: process.env.EMBEDICONURL
    };
}

const createActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('◀️')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('▶️')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === totalPages - 1)
    );

// Tyndale entries prefix each verse with its own "3:16" or "3:16-21" header inline;
// the embed title already shows that, so strip it from the body for cleanliness.
function stripTyndaleReferencePrefix(text, commentatorId) {
    if (commentatorId !== 'tyndale' || !text) return text;
    return text.replace(/^\d+:\d+(-\d+)?\s+/, '');
}

function findCommentator(id) {
    return COMMENTATORS.find(c => c.id === id);
}

export default {
    data: new SlashCommandBuilder()
        .setName('commentary')
        .setDescription("Look up Bible commentary (verse or chapter level) from classic commentators")
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want commentary for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number (omit for chapter-level commentary)')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('commentator')
                .setDescription(`Which commentator to use (default: Jamieson-Fausset-Brown)`)
                .setRequired(false)
                .addChoices(
                    ...COMMENTATORS.map(c => ({ name: c.label, value: c.id }))
                )),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawBook = interaction.options.getString('book');
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');
            const commentatorId = interaction.options.getString('commentator') || DEFAULT_COMMENTATOR_ID;
            const commentator = findCommentator(commentatorId);

            if (!commentator) {
                return interaction.editReply({
                    content: `Unknown commentator selection.`,
                    ephemeral: true
                });
            }

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({
                    content: 'Please provide a valid chapter number (must be 1 or greater).',
                    ephemeral: true
                });
            }

            if (verseInput !== null && (!Number.isInteger(verseInput) || verseInput < 1)) {
                return interaction.editReply({
                    content: 'If provided, verse must be a whole number (1 or greater).',
                    ephemeral: true
                });
            }

            const bookId = getBookId(rawBook);
            const bookName = bookId ? numbersToBook.get(bookId) : null;
            if (!bookId || !bookName) {
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                    ephemeral: true
                });
            }

            const bookCodes = toCommentaryBookCodes(bookId);
            if (bookCodes.length === 0) {
                return interaction.editReply({
                    content: `Book "${bookName}" isn't supported by the commentary database.`,
                    ephemeral: true
                });
            }

            const isChapterLevel = verseInput === null;

            logger.info(`[Commentary Command] ${commentatorId} on ${bookName} ${chapter}${isChapterLevel ? ' (chapter)' : `:${verseInput}`}`);

            let rawText;
            let titleRef;
            if (isChapterLevel) {
                const row = await commentaryWrapper.getChapterCommentary(commentatorId, bookCodes, chapter);
                rawText = row?.introduction;
                titleRef = `${bookName} ${chapter}`;

                if (!rawText) {
                    if (commentatorId === 'tyndale') {
                        return interaction.editReply({
                            content: `**Tyndale Open Study Notes** doesn't include chapter-level introductions. Try adding a verse number, or pick a different commentator (Gill, Matthew Henry, Clarke, etc.).`,
                            ephemeral: true
                        });
                    }
                    return interaction.editReply({
                        content: `${commentator.label} doesn't have a chapter-level introduction for **${bookName} ${chapter}**. Try adding a verse number, or a different commentator.`,
                        ephemeral: true
                    });
                }
            } else {
                const row = await commentaryWrapper.getVerseCommentary(commentatorId, bookCodes, chapter, verseInput);
                rawText = row?.text;
                titleRef = `${bookName} ${chapter}:${verseInput}`;

                if (!rawText) {
                    return interaction.editReply({
                        content: `${commentator.label} doesn't have commentary on **${titleRef}**. Try a different commentator or check the reference.`,
                        ephemeral: true
                    });
                }

                rawText = stripTyndaleReferencePrefix(rawText, commentatorId);
            }

            const chunks = splitString(rawText, MAX_CHARS_PER_CHUNK);
            if (chunks.length === 0) {
                return interaction.editReply({ content: `Failed to format commentary for ${titleRef}.`, ephemeral: true });
            }

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
            let currentPageIndex = 0;

            const buildEmbed = (idx) => new EmbedBuilder()
                .setColor(embedColor)
                .setTitle(`📖 ${commentator.label}: ${titleRef}${isChapterLevel ? ' (chapter intro)' : ''}`)
                .setDescription(chunks[idx])
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(commentator.label, idx, chunks.length));

            if (chunks.length === 1) {
                return interaction.editReply({ embeds: [buildEmbed(0)] });
            }

            const message = await interaction.editReply({
                embeds: [buildEmbed(currentPageIndex)],
                components: [createActionRow(currentPageIndex, chunks.length)]
            });

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % chunks.length;
                    } else if (i.customId === 'page_back') {
                        currentPageIndex = (currentPageIndex - 1 + chunks.length) % chunks.length;
                    }
                    await i.editReply({
                        embeds: [buildEmbed(currentPageIndex)],
                        components: [createActionRow(currentPageIndex, chunks.length)]
                    });
                } catch (collectError) {
                    logger.error(`[Commentary Command] Error updating pagination: ${collectError}`);
                    try {
                        await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                    } catch (followUpError) {
                        logger.error(`[Commentary Command] Error sending follow-up after pagination error: ${followUpError}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[Commentary Command] Pagination collector ended for ${titleRef}`);
                const timedOutRow = createActionRow(currentPageIndex, chunks.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    if (editError.code !== 10008) logger.error(`[Commentary Command] Error disabling buttons after timeout: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[Commentary Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: 'Sorry, there was an error fetching or processing the commentary. Please try again later.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[Commentary Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};
