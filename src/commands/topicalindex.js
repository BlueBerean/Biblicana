const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { bibleWrapper } = require('../utils/bibleHelper');
const swearWordFilter = require('../utils/filter');
const splitString = require('../utils/splitString');
require('dotenv').config();

// --- Constants ---
const API_TIMEOUT_MS = 8000; // 8 seconds timeout for API calls
const COLLECTOR_TIMEOUT_MS = 600_000; // 10 minutes
const ITEMS_PER_PAGE = 10; // Number of verses/topics per page
const MAX_CHARS_PER_PAGE = 4000; // Embed description limit
const MAX_VERSE_PREVIEW_LENGTH = 300; // Max length for verse text preview

// --- Helper Functions ---

// Standard footer generation
function generateFooter(page = 0, maxPages = 1, translation = null, totalCount = null) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    const transText = translation ? ` | Translation: ${translation.toUpperCase()}` : '';
    const countText = totalCount !== null ? ` | Total Verses: ${totalCount}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT}${transText}${countText}${pageText}`,
        iconURL: process.env.EMBEDICONURL
    };
}

// Standard button row creation
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

// Function to fetch and format verses for a given page of references
async function formatVersesForPage(references, translation) {
    if (!references || references.length === 0) {
        return 'No verses for this page.';
    }

    // Use Promise.allSettled for resilience when fetching multiple verses
    const verseFetchPromises = references.map(async (verseRef) => {
        const citation = verseRef?.citation || 'Invalid Reference';
        const errorPrefix = `• ${citation}:`; // Define prefix for errors

        if (!verseRef || !Array.isArray(verseRef.verseIds) || verseRef.verseIds.length === 0) {
            logger.warn(`[TopicalIndex Command] Invalid verse reference object: ${JSON.stringify(verseRef)}`);
            return `${errorPrefix} Error processing reference`;
        }

        const firstVerseId = verseRef.verseIds[0];
        const lastVerseId = verseRef.verseIds[verseRef.verseIds.length - 1];

        try {
            // Safely parse IDs
            const bookId = parseInt(firstVerseId.substring(0, 2));
            const chapter = parseInt(firstVerseId.substring(2, 5));
            const startVerseNum = parseInt(firstVerseId.substring(5));
            const endVerseNum = parseInt(lastVerseId.substring(5));

            if (isNaN(bookId) || isNaN(chapter) || isNaN(startVerseNum) || isNaN(endVerseNum)) {
                throw new Error('Invalid parsed IDs');
            }

            // Fetch verse data (no timeout here, handled by Promise.race if needed upstream)
            const versesData = await bibleWrapper.getVerses(bookId, chapter, startVerseNum, endVerseNum);

            if (!versesData || versesData.length === 0) {
                throw new Error('Verse not found in DB');
            }

            // Combine text, using preferred translation or fallback
            const verseText = versesData.map(v => v[translation] || v['BSB'] || v['KJV'] || '(Text unavailable)').join(' ');
            const truncatedText = verseText.length > MAX_VERSE_PREVIEW_LENGTH
                ? verseText.substring(0, MAX_VERSE_PREVIEW_LENGTH - 3) + '...'
                : verseText;

            return `• **${citation}**: ${truncatedText}`; // Return formatted string

        } catch (error) {
            logger.warn(`[TopicalIndex Command] Failed to fetch/format verse ${citation || firstVerseId}: ${error.message}`);
            return `${errorPrefix} Error fetching text`; // Return formatted error string
        }
    });

    const results = await Promise.allSettled(verseFetchPromises);

    // Map results, handling fulfilled and rejected promises
    const formattedVerses = results.map(result =>
        result.status === 'fulfilled' ? result.value : '• Error processing verse reference.'
    );

    return formattedVerses.join('\n\n'); // Join verses with double newline
}

// --- Command Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('topicalindex')
        .setDescription('Search the Bible by topic or view all topics')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic to search for (e.g., faith, love, hope)')
                .setRequired(false) // Not required if showall is true
                .setMinLength(3)
                .setMaxLength(100))
        .addBooleanOption(option =>
            option.setName('showall')
                .setDescription('Show all available topics instead of searching')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Verse translation (defaults to your preference or BSB)')
                .setRequired(false) // Optional
                .addChoices(
                     { name: 'BSB', value: 'BSB' },
                     { name: "NASB", value: "NASB" },
                     { name: 'KJV', value: 'KJV' },
                     { name: "NKJV", value: "NKJV" },
                     { name: 'ASV', value: 'ASV' },
                     { name: "AKJV", value: "AKJV" }
                    // Add other supported choices
                )),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            const rawTopic = interaction.options.getString('topic');
            const topic = rawTopic ? swearWordFilter(rawTopic.trim().toLowerCase()) : null;
            const showAll = interaction.options.getBoolean('showall') ?? false;

            if (!topic && !showAll) {
                return interaction.editReply({
                    content: 'Please provide a topic to search for, or set `showall` to true to list all topics.',
                    ephemeral: true
                });
            }

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            // --- Handle Show All Topics ---
            if (showAll) {
                logger.info("[TopicalIndex Command] Requesting all topics.");
                const options = {
                    method: 'GET',
                    url: 'https://iq-bible.p.rapidapi.com/GetTopics',
                    headers: {
                        'x-rapidapi-key': process.env.RAPIDAPIKEY,
                        'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                    }
                };

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                    const response = await axios.request({ ...options, signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
                        throw new Error('Invalid or empty topic list received from API.');
                    }

                    const allTopics = response.data.sort().join(', \n'); // Sort and join
                    const pages = splitString(allTopics, MAX_CHARS_PER_PAGE); // Use splitString utility
                    let currentPageIndex = 0;

                    if (pages.length === 0) { // Safety check
                        return interaction.editReply({ content: 'Failed to format the topic list.', ephemeral: true });
                    }

                    const embed = new EmbedBuilder()
                        .setTitle('📚 Available Bible Topics')
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
                    // Pass ComponentType.Button if needed by your discord.js version
                    const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

                    collector.on('collect', async i => {
                        try {
                            await i.deferUpdate();
                            if (i.customId === 'page_back') currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                            else if (i.customId === 'page_next') currentPageIndex = (currentPageIndex + 1) % pages.length;

                            embed.setDescription(pages[currentPageIndex])
                                .setFooter(generateFooter(currentPageIndex, pages.length));
                            await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                        } catch (collectError) { logger.error(`[TopicalIndex Command - ShowAll] Collector error: ${collectError}`); }
                    });

                    collector.on('end', () => {
                        const finalComponents = createActionRow(currentPageIndex, pages.length, true);
                        message.edit({ components: [finalComponents] }).catch(e => { if (e.code !== 10008) logger.error(`[TopicalIndex Command - ShowAll] Error disabling components: ${e}`); });
                    });

                    return; // End execution after handling showAll

                } catch (apiError) {
                    logger.error(`[TopicalIndex Command - ShowAll] API request failed: ${apiError.message}`);
                    return interaction.editReply({ content: 'Sorry, failed to fetch the list of topics.', ephemeral: true });
                }
            }

            // --- Handle Topic Search ---
            logger.info(`[TopicalIndex Command] Searching for topic: "${topic}"`);

            // Use translation logic again
            let translation = 'BSB'; // Default
            try {
                 const userPref = await database.getUserValue(interaction.user.id); // Use database parameter
                 if (userPref?.translation) translation = userPref.translation;
             } catch (dbError) { logger.error(`[TopicalIndex Command] Failed to get user preference: ${dbError}`); }
             translation = interaction.options.getString('translation') || translation; // Get selected option

            // Fetch references and count concurrently
            const apiHeaders = {
                'x-rapidapi-key': process.env.RAPIDAPIKEY,
                'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
            };
            const apiTimeout = API_TIMEOUT_MS; // Use constant

            const [topicResult, countResult] = await Promise.allSettled([
                axios.request({
                    method: 'GET', url: 'https://iq-bible.p.rapidapi.com/GetTopic',
                    params: { topic }, headers: apiHeaders, // Reuse headers
                    timeout: apiTimeout // Add timeout directly
                }),
                axios.request({
                    method: 'GET', url: 'https://iq-bible.p.rapidapi.com/GetTopicVerseCount',
                    params: { topic }, headers: apiHeaders,
                    timeout: apiTimeout
                })
            ]);

            // Validate topic response
            if (topicResult.status === 'rejected' || !topicResult.value?.data || !Array.isArray(topicResult.value.data) || topicResult.value.data.length === 0) {
                const reason = topicResult.reason?.message || 'Invalid data or topic not found';
                logger.warn(`[TopicalIndex Command] No topic references found or API error for "${topic}": ${reason}`);
                // Check for 404 specifically if the API uses it for "not found"
                if (topicResult.reason?.response?.status === 404) {
                    return interaction.editReply({ content: `❌ Topic "${topic}" not found. Use \`/topicalindex showall:true\` to see available topics.`, ephemeral: true });
                }
                return interaction.editReply({ content: `Error fetching topic references: ${reason}.`, ephemeral: true });
            }
            const verseReferences = topicResult.value.data; // Array of { citation: "...", verseIds: ["..."] }

            // Get verse count (best effort)
            let verseCount = 'N/A';
            if (countResult.status === 'fulfilled' && countResult.value?.data) {
                verseCount = countResult.value.data.toString();
            } else {
                logger.warn(`[TopicalIndex Command] Failed to get verse count for "${topic}": ${countResult.reason?.message}`);
            }

            // Paginate the references
            const totalPages = Math.ceil(verseReferences.length / ITEMS_PER_PAGE);
            let currentPageIndex = 0;

            // Fetch and format verses for the first page
            const initialPageRefs = verseReferences.slice(0, ITEMS_PER_PAGE);
            // Pass determined translation to the helper
            const initialPageContent = await formatVersesForPage(initialPageRefs, translation);

            // Create initial embed
            const embed = new EmbedBuilder()
                .setTitle(`📖 Bible Verses about "${rawTopic}"`) // Use raw topic
                .setDescription(initialPageContent)
                .setColor(embedColor)
                .addFields([{ name: 'Total Related Verses', value: verseCount, inline: true }])
                // Pass determined translation to footer
                .setFooter(generateFooter(currentPageIndex, totalPages, translation));

            // Send initial response
            const message = await interaction.editReply({
                embeds: [embed],
                components: totalPages > 1 ? [createActionRow(currentPageIndex, totalPages)] : []
            });

            if (totalPages <= 1) return; // No collector needed

            // Setup collector for pagination
            const filter = i => i.user.id === interaction.user.id;
            // Pass ComponentType.Button if needed by your discord.js version
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    let newPageIndex = currentPageIndex;
                    if (i.customId === 'page_back') newPageIndex--;
                    else if (i.customId === 'page_next') newPageIndex++;

                    // Clamp page index
                    newPageIndex = Math.max(0, Math.min(newPageIndex, totalPages - 1));

                    // Only refetch if page actually changed
                    if (newPageIndex !== currentPageIndex) {
                        currentPageIndex = newPageIndex;
                        const start = currentPageIndex * ITEMS_PER_PAGE;
                        const end = start + ITEMS_PER_PAGE;
                        const pageRefs = verseReferences.slice(start, end);

                        // Fetch content for the new page using the chosen translation
                        const pageContent = await formatVersesForPage(pageRefs, translation);

                        embed.setDescription(pageContent)
                             // Pass determined translation to footer
                             .setFooter(generateFooter(currentPageIndex, totalPages, translation));

                        await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, totalPages)] });
                    }
                } catch (collectError) {
                    logger.error(`[TopicalIndex Command - Search] Collector error: ${collectError}`);
                    // Optional: notify user on error
                    // try { await i.followUp({ content: 'Error changing page.', ephemeral: true }); } catch {}
                }
            });

            collector.on('end', () => {
                logger.info(`[TopicalIndex Command - Search] Pagination collector ended for topic "${topic}"`);
                const finalComponents = createActionRow(currentPageIndex, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(e => { if (e.code !== 10008) logger.error(`[TopicalIndex Command - Search] Error disabling components: ${e}`); });
            });

        } catch (error) {
            logger.error(`[TopicalIndex Command] Unhandled error: ${error.message}`, error.stack);
            try {
                // Ensure reply is sent even if initial defer failed somehow
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Sorry, there was an unexpected error.', ephemeral: true });
                } else {
                    await interaction.editReply({ content: '❌ Sorry, there was an unexpected error.', embeds: [], components: [], ephemeral: true });
                }
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[TopicalIndex Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
}; 