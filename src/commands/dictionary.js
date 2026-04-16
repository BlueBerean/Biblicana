import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { dictionaryWrapper } from '../utils/studyHelper.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 4000;
const COLLECTOR_TIMEOUT_MS = 600_000;

function generateFooter(page, maxPages, matchType) {
    const matchLabel = matchType === 'definition' ? ' | Fallback match' : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${page + 1}/${maxPages}${matchLabel}`,
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
        .setName('dictionary')
        .setDescription("Look up a word in Easton's and Smith's Bible Dictionaries")
        .addStringOption(option =>
            option.setName('word')
                .setDescription('The word to look up')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawWord = interaction.options.getString('word').trim();
            const searchWord = swearWordFilter(rawWord);

            if (!searchWord) {
                return interaction.editReply({ content: 'Please provide a valid word.', ephemeral: true });
            }

            logger.info(`[Dictionary Command] Looking up: "${searchWord}"`);

            const { results, matchType } = await dictionaryWrapper.search(searchWord);

            if (!results || results.length === 0) {
                logger.warn(`[Dictionary Command] No results for "${searchWord}"`);
                return interaction.editReply({
                    content: `❌ No definition found for "${rawWord}" in Easton's or Smith's Bible Dictionary.`,
                    ephemeral: true
                });
            }

            logger.info(`[Dictionary Command] Found ${results.length} result(s), matchType=${matchType}`);

            // Flatten: each page = one chunk of one result's definition
            const pages = [];
            for (const r of results) {
                const chunks = splitString(r.definition || '(No definition text)', MAX_CHARS_PER_CHUNK);
                chunks.forEach((chunk, chunkIdx) => {
                    pages.push({
                        chunk,
                        term: r.term,
                        source: r.source_name,
                        chunkIdx,
                        totalChunksForResult: chunks.length,
                    });
                });
            }

            if (pages.length === 0) {
                logger.error(`[Dictionary Command] No pages produced for "${searchWord}"`);
                return interaction.editReply({ content: 'An error occurred while formatting the definition.', ephemeral: true });
            }

            const totalPages = pages.length;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const buildEmbed = (idx) => {
                const p = pages[idx];
                const baseTitle = matchType === 'exact'
                    ? `📖 ${p.term} — ${p.source}`
                    : `📖 "${p.term}" (mentions "${rawWord}") — ${p.source}`;
                const chunkSuffix = p.totalChunksForResult > 1
                    ? ` (${p.chunkIdx + 1}/${p.totalChunksForResult})`
                    : '';
                return new EmbedBuilder()
                    .setTitle(`${baseTitle}${chunkSuffix}`)
                    .setDescription(p.chunk)
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                    .setFooter(generateFooter(idx, totalPages, matchType));
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
                    logger.error(`[Dictionary Command] Pagination error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                logger.info(`[Dictionary Command] Pagination collector ended for "${searchWord}"`);
                const finalComponents = createActionRow(currentPageIndex, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(editError => {
                    if (editError.code !== 10008) logger.error(`[Dictionary Command] Error disabling buttons: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[Dictionary Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: 'An unexpected error occurred. Please try again later.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[Dictionary Command] Failed to send final error reply: ${replyError}`);
            }
        }
    }
};
