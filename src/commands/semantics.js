const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const swearWordFilter = require('../utils/filter');
const splitString = require('../utils/splitString');
require('dotenv').config();

const MAX_CHARS_PER_PAGE = 4000;
const COLLECTOR_TIMEOUT_MS = 600_000;
const API_TIMEOUT_MS = 6000;

function generateFooter(page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT}${pageText}`,
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

function formatRelationType(type) {
    return type.toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
}

function getRelationEmoji(type) {
    switch(type.toLowerCase()) {
        case 'synonyms': return '🟢';
        case 'antonyms': return '🔴';
        case 'related_terms': return '🔵';
        case 'broader_terms': return '⬆️';
        case 'narrower_terms': return '⬇️';
        default: return '•';
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('semantics')
        .setDescription('Find semantic relations for a Biblical word or concept')
        .addStringOption(option => 
            option.setName('word')
                .setDescription('The word you want to find semantic relations for')
                .setRequired(true)
                .setMaxLength(100)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawWord = interaction.options.getString('word').trim();
            const word = swearWordFilter(rawWord);

            if (!word) {
                return interaction.editReply({ content: 'Please provide a valid word.', ephemeral: true });
            }

            logger.info(`[Semantics Command] Looking up relations for: "${word}"`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetSemanticRelations',
                params: { word },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            let apiResponseData;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                const response = await axios.request({...options, signal: controller.signal });
                clearTimeout(timeoutId);
                apiResponseData = response.data;
                logger.debug("[Semantics Command] Raw API Response:", JSON.stringify(apiResponseData));
            } catch (apiError) {
                logger.error(`[Semantics Command] API request failed for "${word}": ${apiError.message}`);
                if (apiError.response) {
                    logger.error(`[Semantics Command] API Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`);
                }
                return interaction.editReply({ content: 'Sorry, failed to fetch semantic relations from the source.', ephemeral: true });
            }

            if (!apiResponseData || typeof apiResponseData !== 'object' || Object.keys(apiResponseData).length === 0) {
                logger.warn(`[Semantics Command] No relations found or invalid format for "${word}".`);
                return interaction.editReply({ content: `❌ No semantic relations found for "${word}". Try a different word or check spelling.`, ephemeral: true });
            }

            let combinedContent = `🔍 Exploring semantic relationships for **${rawWord}**\n\n`;
            let relationsFound = false;

            for (const type in apiResponseData) {
                const words = apiResponseData[type];
                if (words && Array.isArray(words)) {
                    const validWords = words.filter(w => w && typeof w === 'string' && w.trim()).map(w => w.trim());
                    if (validWords.length > 0) {
                        relationsFound = true;
                        const formattedType = formatRelationType(type);
                        const emoji = getRelationEmoji(type);
                        combinedContent += `**${formattedType}:**\n${validWords.map(w => `${emoji} ${w}`).join('\n')}\n\n`;
                    }
                }
            }

            if (!relationsFound) {
                logger.warn(`[Semantics Command] API returned data for "${word}" but no valid relations found after processing.`);
                return interaction.editReply({ content: `❌ No valid semantic relations found for "${word}".`, ephemeral: true });
            }

            const pages = splitString(combinedContent.trim(), MAX_CHARS_PER_PAGE);

            if (pages.length === 0) {
                logger.error("[Semantics Command] Failed to create pages from combined content.");
                return interaction.editReply({ content: 'Sorry, an error occurred while formatting the relations.', ephemeral: true });
            }

            let currentPageIndex = 0;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📚 Semantic Relations for "${rawWord}"`)
                .setDescription(pages[currentPageIndex])
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(currentPageIndex, pages.length));

            const message = await interaction.editReply({ 
                embeds: [embed], 
                components: pages.length > 1 ? [createActionRow(currentPageIndex, pages.length)] : []
            });

            if (pages.length <= 1) return;

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
                        currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                    } else if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % pages.length;
                }

                    embed.setDescription(pages[currentPageIndex])
                         .setFooter(generateFooter(currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                } catch (collectError) {
                    logger.error(`[Semantics Command] Error updating pagination: ${collectError}`);
                    try { await i.followUp({ content: 'Error changing page.', ephemeral: true }); } catch (followUpError) {
                        logger.warn(`[Semantics Command] Failed to send follow-up pagination error: ${followUpError.message}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[Semantics Command] Pagination collector ended for "${word}"`);
                const timedOutRow = createActionRow(currentPageIndex, pages.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    if (editError.code !== 10008) {
                        logger.error(`[Semantics Command] Error disabling buttons: ${editError}`);
                    }
                });
            });

        } catch (error) {
            logger.error(`[Semantics Command] Unhandled error: ${error.message}`, error.stack);
            try {
            await interaction.editReply({ 
                    content: '❌ Sorry, there was an unexpected error processing your request.',
                    ephemeral: true,
                    embeds: [], components: []
            });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Semantics Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
}; 