import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import { numbersToBook } from '../utils/bibleHelper.js';
import { commentaryWrapper, fromCommentaryBookCode } from '../utils/studyHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 3800;
const COLLECTOR_TIMEOUT_MS = 600_000;

function formatScriptureRef(p) {
    const bookId = fromCommentaryBookCode(p.referenceBook);
    const bookName = bookId ? numbersToBook.get(bookId) : p.referenceBook;
    if (!bookName) return null;

    const chapter = p.referenceChapter;
    const verse = p.referenceVerse;
    const endChapter = p.referenceEndChapter;
    const endVerse = p.referenceEndVerse;

    if (!chapter) return bookName;

    if (endChapter && endChapter !== chapter) {
        const endPart = endVerse ? `${endChapter}:${endVerse}` : `${endChapter}`;
        return `${bookName} ${chapter}:${verse} – ${endPart}`;
    }
    if (endVerse && endVerse !== verse) {
        return `${bookName} ${chapter}:${verse}-${endVerse}`;
    }
    return verse ? `${bookName} ${chapter}:${verse}` : `${bookName} ${chapter}`;
}

function generateFooter(page, maxPages, source) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | ${source}${pageText}`,
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

export default {
    data: new SlashCommandBuilder()
        .setName('profile')
        .setDescription('Look up a biblical figure or topic in Tyndale Open Study Notes')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Subject to look up (e.g., Abraham, David, The Pharisees)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawTopic = interaction.options.getString('topic').trim();
            const cleanTopic = swearWordFilter(rawTopic);
            if (!cleanTopic) {
                return interaction.editReply({ content: 'Please provide a valid topic.', ephemeral: true });
            }

            logger.info(`[Profile Command] Searching: "${cleanTopic}"`);

            const { results, matchType } = await commentaryWrapper.searchProfiles(cleanTopic);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    content: `❌ No profile found for "${rawTopic}". Try names like Abraham, David, Mary, or groups like "The Pharisees".`,
                    ephemeral: true
                });
            }

            logger.info(`[Profile Command] Found ${results.length} profile(s), matchType=${matchType}`);

            const pages = [];
            for (const p of results) {
                const ref = formatScriptureRef(p);
                const chunks = splitString(p.content || '(No content)', MAX_CHARS_PER_CHUNK);
                chunks.forEach((chunk, chunkIdx) => {
                    pages.push({
                        chunk,
                        subject: p.subject,
                        reference: ref,
                        source: p.commentaryName || 'Tyndale Open Study Notes',
                        chunkIdx,
                        totalChunksForProfile: chunks.length,
                    });
                });
            }

            if (pages.length === 0) {
                return interaction.editReply({ content: 'An error occurred while formatting the profile.', ephemeral: true });
            }

            const totalPages = pages.length;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const buildEmbed = (idx) => {
                const p = pages[idx];
                const titleBase = matchType === 'fuzzy'
                    ? `📚 Profile: ${p.subject} (match for "${rawTopic}")`
                    : `📚 Profile: ${p.subject}`;
                const chunkSuffix = p.totalChunksForProfile > 1
                    ? ` (${p.chunkIdx + 1}/${p.totalChunksForProfile})`
                    : '';

                const embed = new EmbedBuilder()
                    .setTitle(`${titleBase}${chunkSuffix}`)
                    .setDescription(p.chunk)
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                    .setFooter(generateFooter(idx, totalPages, p.source));

                if (p.chunkIdx === 0 && p.reference) {
                    embed.addFields({ name: '📖 Primary Reference', value: p.reference, inline: true });
                }

                return embed;
            };

            let currentPageIndex = 0;
            const message = await interaction.editReply({
                embeds: [buildEmbed(currentPageIndex)],
                components: totalPages > 1 ? [createActionRow(currentPageIndex, totalPages)] : []
            });

            if (totalPages <= 1) return;

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') {
                        currentPageIndex = Math.max(0, currentPageIndex - 1);
                    } else if (i.customId === 'page_next') {
                        currentPageIndex = Math.min(totalPages - 1, currentPageIndex + 1);
                    }
                    await i.editReply({
                        embeds: [buildEmbed(currentPageIndex)],
                        components: [createActionRow(currentPageIndex, totalPages)]
                    });
                } catch (collectError) {
                    logger.error(`[Profile Command] Pagination error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                logger.info(`[Profile Command] Pagination collector ended for "${rawTopic}"`);
                const finalComponents = createActionRow(currentPageIndex, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(editError => {
                    if (editError.code !== 10008) logger.error(`[Profile Command] Error disabling buttons: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[Profile Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: 'An unexpected error occurred. Please try again later.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[Profile Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
