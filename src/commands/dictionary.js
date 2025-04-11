const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const splitString = require('../utils/splitString');
const swearWordFilter = require('../utils/filter');
require('dotenv').config();

// Constants
const MAX_CHARS_PER_CHUNK = 4000; // Discord embed description limit is 4096
const COLLECTOR_TIMEOUT_MS = 600_000; // 10 minutes (adjust as needed)

// Helper to generate embed footer
function generateFooter(page, maxPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${page + 1}/${maxPages}`,
        iconURL: process.env.EMBEDICONURL
    };
}

// Helper to create the action row with buttons
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

// Function to clean dictionary definition text
function cleanDefinitionText(text) {
    if (typeof text !== 'string' || !text) return '';

    // Remove known tags/patterns, then clean up whitespace
    let cleanText = text
        .replace(/\(<reflink[^>]*>[^<]*<\/reflink>\)/g, '') // Remove <reflink> tags
        .replace(/\([^)]*\d+:\d+[^)]*\)/g, '') // Remove verse references like (John 3:16)
        .replace(/\[[^\]]*\]/g, '') // Remove content in [square brackets]
        .replace(/<[^>]*>/g, '') // Remove any other HTML/XML tags
        .replace(/\s+/g, ' ') // Collapse multiple spaces
        .trim();

    // Specific formatting adjustment (optional, based on observed API output)
    // Example: Make text in initial parentheses italic
    // cleanText = cleanText.replace(/^\((.*?)\)/, '\*($1)\*\n\n');

    return cleanText;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dictionary')
        .setDescription("Look up a word in Smith's Bible Dictionary")
        .addStringOption(option =>
            option.setName('word')
                .setDescription('The word to look up')
                .setRequired(true)
                .setMaxLength(100)), // Consistent max length

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawWord = interaction.options.getString('word').trim();
            const searchWord = swearWordFilter(rawWord);

            if (!searchWord) {
                return interaction.editReply({ content: 'Please provide a valid word.', ephemeral: true });
            }

            logger.info(`[Dictionary Command] Looking up: "${searchWord}"`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetDefinitionBiblical',
                params: {
                    query: searchWord,
                    dictionaryId: 'smiths'
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            let definitionText = '';
            try {
                const response = await axios.request(options);
                logger.debug('[Dictionary Command] API Response Status:', response.status);

                // Process response data
                const responseData = response.data;
                if (!responseData) {
                     throw new Error('API returned no data.');
                }

                if (typeof responseData === 'string') {
                    // Sometimes the API returns a plain string message for "not found"
                    if (responseData.toLowerCase().includes('not found')) {
                         logger.warn(`[Dictionary Command] API returned "not found" string for "${searchWord}"`);
                         return interaction.editReply({ content: `❌ No definition found for "${searchWord}".`, ephemeral: true });
                    }
                    // Otherwise, try cleaning it as if it's the definition
                    definitionText = cleanDefinitionText(responseData);
                } else if (Array.isArray(responseData)) {
                    definitionText = responseData
                        .map(item => cleanDefinitionText(item?.definition || item?.text || JSON.stringify(item)))
                        .filter(Boolean) // Remove empty strings after cleaning
                        .join('\n\n---\n\n'); // Join multiple definitions with a separator
                } else if (typeof responseData === 'object') {
                    // Handle single object definition
                    definitionText = cleanDefinitionText(responseData.definition || responseData.text || JSON.stringify(responseData));
            } else {
                    throw new Error(`Unexpected API response format: ${typeof responseData}`);
                }

            } catch (apiError) {
                logger.error(`[Dictionary Command] API request failed for "${searchWord}": ${apiError.message}`, apiError.stack);
                 if (apiError.response) {
                    logger.error(`[Dictionary Command] API Error Status: ${apiError.response.status}`);
                    logger.error(`[Dictionary Command] API Error Data: ${JSON.stringify(apiError.response.data)}`);
                }
                return interaction.editReply({ content: 'Sorry, there was an error communicating with the dictionary API. Please try again later.', ephemeral: true });
            }

            if (!definitionText) {
                logger.warn(`[Dictionary Command] No definition content found for "${searchWord}" after processing API response.`);
                return interaction.editReply({ content: `❌ No definition found for "${searchWord}".`, ephemeral: true });
            }

            // Split the definition into chunks
            const chunks = splitString(definitionText, MAX_CHARS_PER_CHUNK);
             if (chunks.length === 0) {
                 logger.error(`[Dictionary Command] Failed to split definition text into chunks for "${searchWord}"`);
                 return interaction.editReply({ content: 'An error occurred while formatting the definition.', ephemeral: true });
            }

            // Use parseInt for safer color handling, provide a default
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR) : 0x0099FF;
            
            // Create the first embed
            let currentPageIndex = 0;
            const embed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle(`📚 Smith's Definition: ${rawWord}`) // Use rawWord for title
                .setDescription(chunks[currentPageIndex])
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(currentPageIndex, chunks.length));

            // Send the response
             const message = await interaction.editReply({
                embeds: [embed],
                components: [createActionRow(currentPageIndex, chunks.length, chunks.length === 1)]
            });

            // Stop if only one page
            if (chunks.length === 1) return;

             // Setup collector
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
                        currentPageIndex = (currentPageIndex - 1 + chunks.length) % chunks.length;
                    } else if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % chunks.length;
                    }

                    // Update embed description and footer
                    embed.setDescription(chunks[currentPageIndex])
                         .setFooter(generateFooter(currentPageIndex, chunks.length));

                    await i.editReply({
                        embeds: [embed],
                        components: [createActionRow(currentPageIndex, chunks.length)]
                    });
                } catch (collectError) {
                    logger.error(`[Dictionary Command] Error updating pagination: ${collectError}`);
                     try {
                         await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                     } catch { /* Ignore */ }
                }
            });

            collector.on('end', () => {
                logger.info(`[Dictionary Command] Pagination collector ended for "${searchWord}"`);
                const timedOutRow = createActionRow(currentPageIndex, chunks.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                     logger.error(`[Dictionary Command] Error disabling buttons after timeout: ${editError}`);
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
    },
};