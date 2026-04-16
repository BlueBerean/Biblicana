import { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { fathersWrapper, toCommentaryBookVariants } from '../utils/studyHelper.js';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_TEXT_LENGTH = 3800;
const COLLECTOR_TIMEOUT_MS = 600_000;

function generateFooter(page, maxPages, totalResults) {
    const pageText = maxPages > 1 ? ` | Commentary ${page + 1}/${maxPages}` : '';
    const totalText = totalResults ? ` | Total: ${totalResults}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT}${totalText}${pageText}`,
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
            .setDisabled(isEnd || currentPage >= totalPages - 1)
    );

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 3) + '...';
}

export default {
    data: new SlashCommandBuilder()
        .setName('fathers')
        .setDescription('Search Early Church Fathers\' commentary on a biblical passage')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Bible book (e.g., John, Genesis, 1 Corinthians)')
                .setRequired(true)
                .setMaxLength(50))
        .addIntegerOption(option =>
            option.setName('chapter')
                .setDescription('Chapter number')
                .setRequired(true)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('verse')
                .setDescription('Verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('father')
                .setDescription('Filter to a specific Church Father (e.g., Augustine, Chrysostom)')
                .setRequired(false)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawBook = swearWordFilter(interaction.options.getString('book').trim());
            const chapter = interaction.options.getInteger('chapter');
            const verse = interaction.options.getInteger('verse');
            const fatherFilter = interaction.options.getString('father')?.trim() || null;

            const bookId = getBookId(rawBook);
            const canonicalBookName = bookId ? numbersToBook.get(bookId) : null;
            if (!bookId || !canonicalBookName) {
                return interaction.editReply({
                    content: `❌ Unknown book: "${rawBook}". Try "John", "Genesis", "1 Corinthians", etc.`,
                    ephemeral: true
                });
            }

            const bookVariants = toCommentaryBookVariants(canonicalBookName);
            logger.info(`[Fathers Command] Query: ${canonicalBookName} ${chapter}:${verse}${fatherFilter ? ' by ' + fatherFilter : ''}`);

            const results = await fathersWrapper.getByPassage(bookVariants, chapter, verse, fatherFilter);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    content: `❌ No commentary found for **${canonicalBookName} ${chapter}:${verse}**${fatherFilter ? ' from fathers matching "' + fatherFilter + '"' : ''}. Some books (especially minor prophets) have sparse coverage.`,
                    ephemeral: true
                });
            }

            logger.info(`[Fathers Command] Found ${results.length} entries`);

            let currentPage = 0;
            const totalPages = results.length;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const buildEmbed = (idx) => {
                const item = results[idx];
                const description = truncate(item.txt || '(No commentary text available)', MAX_TEXT_LENGTH);
                const sourceLine = item.source_url
                    ? `\n\n*Source: [${item.source_title || 'link'}](${item.source_url})*`
                    : item.source_title ? `\n\n*Source: ${item.source_title}*` : '';

                return new EmbedBuilder()
                    .setTitle(`📜 ${item.father_name} on ${canonicalBookName} ${chapter}:${verse}`)
                    .setDescription(description + sourceLine)
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                    .setFooter(generateFooter(idx, totalPages, totalPages));
            };

            const message = await interaction.editReply({
                embeds: [buildEmbed(currentPage)],
                components: totalPages > 1 ? [createActionRow(currentPage, totalPages)] : []
            });

            if (totalPages <= 1) return;

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') currentPage = Math.max(0, currentPage - 1);
                    else if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                    await i.editReply({ embeds: [buildEmbed(currentPage)], components: [createActionRow(currentPage, totalPages)] });
                } catch (collectError) {
                    logger.error(`[Fathers Command] Collector error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                const finalComponents = createActionRow(currentPage, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(e => {
                    if (e.code !== 10008) logger.error(`[Fathers Command] Error disabling components: ${e}`);
                });
            });
        } catch (error) {
            logger.error(`[Fathers Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: '❌ Sorry, an unexpected error occurred.', embeds: [], components: [], ephemeral: true });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Fathers Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
