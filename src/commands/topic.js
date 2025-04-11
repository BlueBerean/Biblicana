const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const logger = require('../utils/logger');
const axios = require('axios');
require('dotenv').config();

// --- Constants ---
const MAX_NAME_LENGTH = 256;
const MAX_VALUE_LENGTH = 1024;
const MAX_RESULTS_FROM_API = 25; // Process up to 25 results from API
const ITEMS_PER_PAGE = 5; // Show 5 results per embed page
const COLLECTOR_TIMEOUT_MS = 600_000; // 10 minutes
const API_TIMEOUT_MS = 8000; // 8 seconds

// --- Helper Functions ---

// Standard footer generation
function generateFooter(page = 0, maxPages = 1) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return { 
        text: `${process.env.EMBEDFOOTERTEXT}${pageText}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

// Custom action row creator including the disclaimer button
const createComponents = (pageIdx, totalPages, isEnd = false) => {
    return new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('page_back')
                .setEmoji('◀️')
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(isEnd || pageIdx === 0), // Disable based on state
            new ButtonBuilder()
                .setCustomId('page_next')
                .setEmoji('▶️')
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(isEnd || pageIdx >= totalPages - 1), // Disable based on state
            new ButtonBuilder()
                .setStyle(ButtonStyle.Secondary)
                .setLabel("💡 Disclaimer")
                .setCustomId("bias_alert")
                // Disclaimer button remains active even when collector ends
        );
};

// --- Command Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('topic')
        .setDescription('Search commentaries related to a specific topic')
        .addStringOption(option => option.setName('topic').setDescription('The topic to search commentaries for').setRequired(true).setMinLength(3).setMaxLength(100)), // Reduced max length
    async execute(interaction) {
        await interaction.deferReply();

        try {
            // --- Input Validation ---
            const rawTopic = interaction.options.getString('topic').trim();
            const topic = swearWordFilter(rawTopic);

            if (!topic) {
                return interaction.editReply({ content: 'Please provide a valid topic.', ephemeral: true });
            }

            logger.info(`[Topic Command] Searching for topic: "${topic}"`);

            // --- API Request ---
            const options = {
                method: 'GET',
                url: `https://uncovered-treasure-v1.p.rapidapi.com/search/${encodeURIComponent(topic)}`,
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'uncovered-treasure-v1.p.rapidapi.com'
                }
            };

            let apiResponseData;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                const response = await axios.request({ ...options, signal: controller.signal });
                clearTimeout(timeoutId);
                apiResponseData = response.data;
                logger.debug("[Topic Command] Raw API Response:", JSON.stringify(apiResponseData));

            } catch (apiError) {
                logger.error(`[Topic Command] API request failed for topic "${topic}": ${apiError.message}`);
                if (apiError.response) {
                    logger.error(`[Topic Command] API Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`);
                }
                return interaction.editReply({ content: 'Sorry, failed to fetch commentary data from the source. Please try again later.', ephemeral: true });
            }

            // --- Validate and Process API Response ---
            if (!apiResponseData || !Array.isArray(apiResponseData.results) || apiResponseData.results.length === 0) {
                logger.warn(`[Topic Command] No results found or invalid format for topic "${topic}".`);
                return await interaction.editReply({ content: `❌ No commentaries found related to "${topic}"!`, ephemeral: true });
            }

            // --- Format Results into Embed Fields ---
            const fields = apiResponseData.results
                .slice(0, MAX_RESULTS_FROM_API) // Limit results processed
                .map(result => {
                    // Validate result structure and types
                    if (!result || typeof result.context !== 'string' || typeof result.text !== 'string') {
                        logger.warn("[Topic Command] Skipping invalid result item:", result);
                        return null;
                    }
                    // Use context as name, text as value, truncate if needed
                    const name = (result.context.trim() || "Context Unavailable").substring(0, MAX_NAME_LENGTH - (result.context.length > MAX_NAME_LENGTH ? 3 : 0)) + (result.context.length > MAX_NAME_LENGTH ? "..." : "");
                    const value = (result.text.trim() || "Text Unavailable").substring(0, MAX_VALUE_LENGTH - 25) + (result.text.length > MAX_VALUE_LENGTH ? "..." : "") + "\n\n─────────────────────"; // Added separator

                    // Ensure name and value are not empty after trimming/processing
                    if (!name || !value || name === "Context Unavailable" || value === "Text Unavailable") {
                        logger.warn("[Topic Command] Skipping result item with empty name or value after processing:", result);
                        return null;
                    }

                    return { name, value, inline: false };
                })
                .filter(field => field !== null); // Remove skipped invalid results

            if (fields.length === 0) {
                logger.warn(`[Topic Command] No valid commentary results found for "${topic}" after filtering.`);
                return await interaction.editReply({ content: `❌ No valid commentaries found related to "${topic}"!`, ephemeral: true });
            }

            // --- Paginate Fields ---
            const pages = [];
            for (let i = 0; i < fields.length; i += ITEMS_PER_PAGE) {
                pages.push(fields.slice(i, i + ITEMS_PER_PAGE));
            }

            if (pages.length === 0) { // Should not happen, but safety check
                logger.error("[Topic Command] Failed to create pages from fields.");
                return await interaction.editReply({ content: 'Error formatting results.', ephemeral: true });
            }

            // --- Create Initial Embed ---
            let currentPageIndex = 0;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📚 Topic Study: ${rawTopic}`) // Use raw topic
                .setDescription('Here are some relevant commentaries and insights:') // Simplified
                .setURL(process.env.WEBSITE)
                .setColor(embedColor)
                .setFields(pages[currentPageIndex]) // Use setFields
                .setFooter(generateFooter(currentPageIndex, pages.length));

            // --- Send Reply and Handle Pagination/Disclaimer ---
            const message = await interaction.editReply({
                embeds: [embed],
                components: [createComponents(currentPageIndex, pages.length)] // Initial components
            });

            // No collector needed if only one page
            if (pages.length <= 1) return;

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({
                filter,
                // componentType: ComponentType.Button, // Not needed if only buttons
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                // Filter interaction user (redundant due to filter, but safe)
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: '⚠️ You cannot use these buttons.', ephemeral: true });
                    return;
                }

                try {
                    // Handle Disclaimer separately
                    if (i.customId === 'bias_alert') {
                        await i.reply({
                            content: '⚠ Please note that these commentaries represent various theological perspectives and interpretations. Always compare with Scripture and use discernment.',
                            ephemeral: true
                        });
                        return; // Don't process pagination or defer/update
                    }

                    // Handle Pagination
                    await i.deferUpdate(); // Acknowledge interaction quickly
                    if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1); // Simple increment
                        if (currentPageIndex >= pages.length) currentPageIndex = pages.length - 1; // Cap at last page
                    } else if (i.customId === 'page_back') {
                        currentPageIndex = (currentPageIndex - 1); // Simple decrement
                        if (currentPageIndex < 0) currentPageIndex = 0; // Cap at first page
                    }

                    // Update Embed
                    embed.setFields(pages[currentPageIndex]) // Update fields
                        .setFooter(generateFooter(currentPageIndex, pages.length));

                    // Edit the reply with updated embed and components
                    await i.editReply({
                        embeds: [embed],
                        components: [createComponents(currentPageIndex, pages.length)]
                    });

                } catch (collectError) {
                    logger.error(`[Topic Command] Error handling button interaction: ${collectError}`);
                    // Don't try to follow up if deferUpdate failed or interaction is gone
                    // Simply log the error.
                }
            });

            collector.on('end', () => {
                logger.info(`[Topic Command] Pagination collector ended for topic "${topic}"`);
                // Edit message to disable Prev/Next, keep Disclaimer active
                const finalComponents = createComponents(currentPageIndex, pages.length, true); // Pass true to disable pagination buttons
                message.edit({ components: [finalComponents] }).catch(editError => {
                    if (editError.code !== 10008) { // Ignore if message was deleted
                        logger.error(`[Topic Command] Error disabling buttons: ${editError}`);
                    }
                });
            });

        } catch (error) {
            logger.error(`[Topic Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: '❌ Sorry, there was an unexpected error processing your request.',
                    ephemeral: true,
                    embeds: [], components: []
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Topic Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};