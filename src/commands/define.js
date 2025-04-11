const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const { strongsWrapper } = require('../utils/bibleHelper.js');
const logger = require('../utils/logger');
require('dotenv').config();

// Constants
const ITEMS_PER_PAGE = 5;
const COLLECTOR_TIMEOUT_MS = 300_000; // 5 minutes
const HEBREW_COLOR = 0x3498DB; // Keep specific colors for now
const GREEK_COLOR = 0x9B59B6;

// Helper to generate embed footer
function generateFooter(currentPage, totalPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${currentPage + 1}/${totalPages}`,
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

module.exports = {
    data: new SlashCommandBuilder()
        .setName('define')
        .setDescription('Look up the meaning of words in Hebrew or Greek')
        .addStringOption(option =>
            option.setName('lexiconid')
                .setDescription('Choose Hebrew or Greek lexicon')
                .setRequired(true)
                .addChoices(
                    { name: '🔵 Hebrew', value: 'Hebrew' },
                    { name: '🟣 Greek', value: 'Greek' }
                ))
        .addStringOption(option => 
            option.setName('word')
                .setDescription('Enter an English word or Strong\'s number (e.g., H1234 or G123)')
                .setRequired(true)
                .setMaxLength(100)), // Reduced max length slightly

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const lexiconId = interaction.options.getString('lexiconid');
            const rawWord = interaction.options.getString('word').trim(); // Trim input
            const word = swearWordFilter(rawWord); // Apply filter after trimming

            if (!word) {
                return interaction.editReply({ content: 'Please provide a valid word or Strong\'s number.', ephemeral: true });
            }

            // More specific Strong's number check (H or G followed by digits)
            const strongsRegex = /^[HGhg]\d+$/i;
            const isStrongsNumber = strongsRegex.test(word);

            let results = [];
            let queryType = '';

            try {
                if (isStrongsNumber) {
                    queryType = 'Strongs ID';
                    logger.info(`[Define Command] Fetching by Strong's ID: ${word} in ${lexiconId}`);
                    const singleResult = await strongsWrapper.getStrongsId(lexiconId, word);
                    if (singleResult) {
                        results = [singleResult];
                    }
                } else {
                    queryType = 'English Word';
                    logger.info(`[Define Command] Fetching by English word: ${word} in ${lexiconId}`);
                    results = await strongsWrapper.getStrongsEnglish(lexiconId, word);
                }
            } catch (fetchError) {
                logger.error(`[Define Command] Error fetching from strongsWrapper (${queryType}: ${word}, Lexicon: ${lexiconId}): ${fetchError}`);
                return interaction.editReply({ content: 'Sorry, there was an error communicating with the lexicon database. Please try again later.', ephemeral: true });
            }

            if (!results || results.length === 0) {
                logger.warn(`[Define Command] No results found for ${queryType}: ${word} in ${lexiconId}`);
            return interaction.editReply({ 
                content: `❌ No results found for "${word}" in the ${lexiconId} lexicon.`,
                ephemeral: true 
            });
        }

            // Filter out any potentially null/invalid results just in case
            results = results.filter(item => item && item.strongs);
            if (results.length === 0) {
                 logger.warn(`[Define Command] Initial results found but filtered out as invalid for ${queryType}: ${word} in ${lexiconId}`);
                 return interaction.editReply({ content: 'Found potential matches, but couldn\'t process them. Please check your input.', ephemeral: true });
            }

            // Group results into pages
        const pages = [];
            const totalResults = results.length;
            const totalPages = Math.ceil(totalResults / ITEMS_PER_PAGE);

            for (let i = 0; i < totalResults; i += ITEMS_PER_PAGE) {
                const pageItems = results.slice(i, i + ITEMS_PER_PAGE);
                const pageNum = Math.floor(i / ITEMS_PER_PAGE);

                // Use specific colors, could be replaced by env var if desired
                const embedColor = lexiconId === "Greek" ? GREEK_COLOR : HEBREW_COLOR;
            
            const embed = new EmbedBuilder()
                    .setTitle(`📚 ${lexiconId} Word Study - "${rawWord}"`) // Use rawWord for title
                    .setColor(embedColor)
                .setURL(process.env.WEBSITE);

            const descriptions = pageItems.map((item, index) => {
                    // Construct Strong's number safely
                    const strongsPrefix = lexiconId === "Greek" ? "G" : "H";
                    const strongsNumber = item.strongs ? `${strongsPrefix}${item.strongs}` : 'N/A';

                    // Determine definition source
                    const definition = lexiconId === "Greek"
                        ? (item.definition || item.strong_def || 'No definition available.')
                        : (item.strong_def || 'No definition available.');
                    
                    // Format entry
                return [
                        `### ${i + index + 1}. ${strongsNumber}`, // Use global index for numbering
                    '',
                        `**Original Word:** ${item.unicode || 'N/A'}`,
                    `**Transliteration:** ${item.translit || item.xlit || "N/A"}`,
                    '',
                        `**Definition:**`,
                        definition.substring(0, 1000) + (definition.length > 1000 ? '...' : ''), // Limit definition length per item
                    '―――――――――――――――'
                ].join('\n');
            });

                embed.setDescription(descriptions.join('\n')) // Join with single newline for compactness
                     .setFooter(generateFooter(pageNum, totalPages));
            pages.push(embed);
        }

            if (pages.length === 0) { // Should not happen if results were validated, but safety check
                 logger.error(`[Define Command] Processing resulted in zero pages for ${queryType}: ${word}`);
                 return interaction.editReply({ content: 'An unexpected error occurred while formatting the results.', ephemeral: true });
            }

            // Send the first page
            let currentPageIndex = 0;
            const message = await interaction.editReply({
                embeds: [pages[currentPageIndex]],
                components: [createActionRow(currentPageIndex, totalPages, pages.length === 1)]
            });

            // Stop if only one page
            if (pages.length === 1) return;

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
                        currentPageIndex = (currentPageIndex - 1 + totalPages) % totalPages;
                    } else if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % totalPages;
                    }

                    await i.editReply({
                        embeds: [pages[currentPageIndex]], // Footer is already on the embed
                        components: [createActionRow(currentPageIndex, totalPages)]
                    });
                } catch (collectError) {
                    logger.error(`[Define Command] Error updating pagination: ${collectError}`);
                     try {
                         await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                     } catch { /* Ignore follow-up error */ }
                }
        });

        collector.on('end', () => {
                logger.info(`[Define Command] Pagination collector ended for "${word}"`);
                // Edit message to disable buttons
                const timedOutRow = createActionRow(currentPageIndex, totalPages, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                     logger.error(`[Define Command] Error disabling buttons after timeout: ${editError}`);
        });
            });

        } catch (error) {
            logger.error(`[Define Command] Unhandled error: ${error.message}`, error.stack);
            try {
                 await interaction.editReply({
                    content: 'An unexpected error occurred while processing your request. Please try again later.',
                    ephemeral: true
                 });
            } catch (replyError) {
                logger.error(`[Define Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};