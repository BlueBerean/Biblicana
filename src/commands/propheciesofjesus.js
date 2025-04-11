const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');
require('dotenv').config();

// --- Constants ---
const PROPHS_PER_PAGE = 7; // Adjust as needed
const PAGINATION_TIMEOUT_MS = 180000; // 3 minutes

// --- Helper Functions ---
/**
 * Creates a standardized error embed.
 * @param {string} title The title for the embed.
 * @param {string} description The error description.
 * @returns {EmbedBuilder} The configured EmbedBuilder instance.
 */
const createErrorEmbed = (title, description) => {
    const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0xFF0000; // Red for error
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description.substring(0, 4090)) // Limit description length
        .setColor(embedColor)
        .setTimestamp();
};

// Helper to generate embed footer for prophecy pagination
function generateProphecyPageFooter(page, maxPages) {
    return {
        text: `Page ${page + 1}/${maxPages}`,
        iconURL: process.env.EMBEDICONURL // Optional: Reuse standard footer icon
    };
}

// Helper to create the action row with pagination buttons for prophecies
const createProphecyActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back') // Changed from 'prophecy_page_back'
            .setEmoji('⬅️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next') // Changed from 'prophecy_page_next'
            .setEmoji('➡️')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage >= totalPages - 1)
    );

// --- Command Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('propheciesofjesus')
        .setDescription('Displays prophecies about Jesus fulfilled in Scripture (paginated).'),

    async execute(interaction) {
        await interaction.deferReply();

        const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x00FF00; // Green for success

        let prophecies = [];
        try {
            // Construct the path relative to the current file (__dirname)
            // Assumes commands/propheciesofjesus.js and data/prophecies.json share a common ancestor (e.g., src/)
            const filePath = path.join(__dirname, '..', '..', 'data', 'prophecies.json');
            logger.info(`[/PropheciesOfJesus Command] Reading prophecies from: ${filePath}`);
            const fileContent = fs.readFileSync(filePath, 'utf8');
            prophecies = JSON.parse(fileContent);

            if (!Array.isArray(prophecies)) {
                throw new Error('Prophecies data is not an array.');
            }

            logger.info(`[/PropheciesOfJesus Command] Successfully loaded ${prophecies.length} prophecies from file.`);

        } catch (error) {
            logger.error(`[/PropheciesOfJesus Command] Error reading or parsing prophecies.json: ${error.message}`, error.stack);
            const errorEmbed = createErrorEmbed('🧪 File Error', 'Could not load the prophecy data file. Please check server logs.');
            return interaction.editReply({ embeds: [errorEmbed], ephemeral: true });
        }

        if (prophecies.length === 0) {
            const errorEmbed = createErrorEmbed('🧪 No Data', 'The prophecies data file is empty.');
            return interaction.editReply({ embeds: [errorEmbed] });
        }

        // --- Pagination Setup ---
        let currentPageIndex = 0;
        const totalPages = Math.ceil(prophecies.length / PROPHS_PER_PAGE);

        // Function to create the embed for the current prophecy page
        const createProphecyPageEmbed = (pageIndex) => {
            const startIndex = pageIndex * PROPHS_PER_PAGE;
            const currentProphecies = prophecies.slice(startIndex, startIndex + PROPHS_PER_PAGE);
            
            const description = currentProphecies.map(p => 
                `**${p['OT Reference']}:** ${p.Description}\n*Fulfillment: ${p['NT Fulfillment'] || 'N/A'}*`
            ).join('\n\n'); // Add extra newline for spacing

            return new EmbedBuilder()
                .setTitle('📜 Prophecies Fulfilled in Jesus')
                .setDescription(description || 'No prophecies on this page.')
                .setColor(embedColor)
                .setFooter(generateProphecyPageFooter(pageIndex, totalPages))
                .setTimestamp();
        };

        // Send the initial message
        const initialEmbed = createProphecyPageEmbed(currentPageIndex);
        const initialRow = createProphecyActionRow(currentPageIndex, totalPages);

        try {
            const message = await interaction.editReply({
                embeds: [initialEmbed],
                components: totalPages > 1 ? [initialRow] : [], // Only add buttons if multiple pages
                fetchReply: true
            });

            // If only one page, no need for collector
            if (totalPages <= 1) return;

            // Setup button collector
            // Use a more specific filter that checks both the user ID and the custom IDs
            const filter = i => 
                i.user.id === interaction.user.id && 
                (i.customId === 'page_back' || i.customId === 'page_next');

            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: PAGINATION_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    // Immediately defer the update to prevent timeout
                    await i.deferUpdate().catch(e => logger.warn(`[/PropheciesOfJesus Command] Failed to defer update: ${e.message}`));

                    if (i.customId === 'page_next') {
                        currentPageIndex++;
                    } else if (i.customId === 'page_back') {
                        currentPageIndex--;
                    }

                    currentPageIndex = Math.max(0, Math.min(currentPageIndex, totalPages - 1));

                    const updatedEmbed = createProphecyPageEmbed(currentPageIndex);
                    const updatedRow = createProphecyActionRow(currentPageIndex, totalPages);

                    // Use a try-catch for the edit reply to handle any potential issues
                    try {
                        await i.editReply({
                            embeds: [updatedEmbed],
                            components: [updatedRow]
                        });
                    } catch (editError) {
                        logger.error(`[/PropheciesOfJesus Command] Error during editReply: ${editError.message}`);
                        // If interaction is no longer valid, try updating through the original message
                        try {
                            await message.edit({
                                embeds: [updatedEmbed],
                                components: [updatedRow]
                            });
                        } catch (messageEditError) {
                            logger.error(`[/PropheciesOfJesus Command] Failed fallback message edit: ${messageEditError.message}`);
                        }
                    }
                } catch (collectError) {
                    logger.error(`[/PropheciesOfJesus Command] Error updating prophecy pagination: ${collectError}`);
                    // Don't attempt further interaction handling here
                }
            });

            collector.on('end', () => {
                logger.info('[/PropheciesOfJesus Command] Prophecy pagination collector ended.');
                if (!message.deleted) {
                    const finalRow = createProphecyActionRow(currentPageIndex, totalPages, true);
                    message.edit({ components: [finalRow] }).catch(editError => {
                        if (editError.code !== 10008) {
                            logger.warn(`[/PropheciesOfJesus Command] Error disabling buttons after prophecy timeout: ${editError.message}`);
                        }
                    });
                }
            });

        } catch (error) {
            logger.error(`[/PropheciesOfJesus Command] Error during initial message send/edit: ${error.message}`, error.stack);
            // Attempt to send an ephemeral followup if possible
            try {
                if (interaction.channel) { // Check if interaction is still valid
                    const errorEmbed = createErrorEmbed('🧪 Command Error', 'An error occurred while displaying the prophecies.');
                    // Use followup if initial editReply potentially succeeded but collector setup failed
                    if (interaction.replied || interaction.deferred) { 
                        await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
                    } else {
                         await interaction.editReply({ embeds: [errorEmbed], ephemeral: true }); // Should be rare
                    }
                }
            } catch (followUpError) {
                 logger.error(`[/PropheciesOfJesus Command] Failed to send error followup: ${followUpError.message}`);
             }
        }
    }
};
