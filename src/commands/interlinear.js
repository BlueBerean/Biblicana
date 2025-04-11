const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } = require('discord.js');
const { bibleWrapper, strongsWrapper, numbersToBook, getBookId } = require('../utils/bibleHelper.js');
const logger = require('../utils/logger');
const swearWordFilter = require('../utils/filter');
require('dotenv').config();

// --- Constants ---
const VERSE_FETCH_TIMEOUT_MS = 6000; // Slightly increased
const STRONGS_FETCH_TIMEOUT_MS = 5000; // Timeout per Strong's number
const COLLECTOR_TIMEOUT_MS = 600_000; // 10 minutes
const STRONGS_PAGE_CHAR_LIMIT = 1000; // Limit for Strong's field value (actual limit 1024)
const EMBED_FIELD_VALUE_LIMIT = 1024; // Discord limit

// --- Helper Functions ---

// Standard footer generation
function generateFooter(textPrefix, page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return {
        text: `${textPrefix}${pageText}`,
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
            .setDisabled(isEnd || currentPage === totalPages - 1)
    );

// --- Command Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('interlinear')
        .setDescription('Get an interlinear view of a specific Bible verse')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Book name or abbreviation (e.g., gen, john, 1co)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('Chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('Verse number')
                .setRequired(true)
                .setMinValue(1)) // Add min value validation
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Parallel translation (defaults to your preference or BSB)')
                .addChoices(
                    // Full list of choices
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            // --- Input Validation and Setup ---
            const rawBookInput = interaction.options.getString('book').trim();
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');
            const rawBook = swearWordFilter(rawBookInput);

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ content: 'Invalid chapter number provided.', ephemeral: true });
            }
            // verseInput validated by .setMinValue(1)

            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);
            if (!bookId || !bookName) {
                logger.warn(`[Interlinear Command] Invalid book: ${rawBook}`);
                return interaction.editReply({ content: `Invalid book: "${rawBook}". Use names like Genesis, John, 1 Corinthians, or abbreviations like gen, jn, 1co.`, ephemeral: true });
            }

            // Determine translation
            let translation = 'BSB'; // Default
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Interlinear Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            logger.info(`[Interlinear Command] Request: ${bookName} ${chapter}:${verseInput} (${translation})`);

            // --- Fetch Interlinear and English Data ---
            let interlinearDataJson;
            let englishVerseData;
            try {
                const fetchTimeout = (ms, reason = 'Fetch timeout') => new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));

                const [interlinearResult, englishResult] = await Promise.allSettled([
                    Promise.race([bibleWrapper.getInterlinearVerse(bookId, chapter, verseInput), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'Interlinear fetch timeout')]),
                    Promise.race([bibleWrapper.getVerses(bookId, chapter, verseInput, verseInput), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'English verse fetch timeout')])
                ]);

                if (interlinearResult.status === 'rejected' || !interlinearResult.value?.data) {
                    throw new Error(`Failed to fetch interlinear data: ${interlinearResult.reason?.message || 'No data returned'}`);
                }
                if (englishResult.status === 'rejected' || !englishResult.value || englishResult.value.length === 0) {
                    throw new Error(`Failed to fetch English verse data: ${englishResult.reason?.message || 'Not found'}`);
                }

                interlinearDataJson = interlinearResult.value.data;
                englishVerseData = englishResult.value;
                logger.info(`[Interlinear Command] Fetched interlinear and English data.`);

            } catch (fetchError) {
                logger.error(`[Interlinear Command] Error fetching data: ${fetchError.message}`);
                return interaction.editReply({ content: `Sorry, I couldn't fetch the required verse data (${fetchError.message}). Please check the reference or try again later.`, ephemeral: true });
            }

            // --- Parse Interlinear Data ---
            let interlinearItems;
            try {
                interlinearItems = JSON.parse(interlinearDataJson);
                if (!Array.isArray(interlinearItems) || interlinearItems.length === 0) {
                    throw new Error('Parsed data is not a valid array or is empty.');
                }
            } catch (parseError) {
                logger.error(`[Interlinear Command] Error parsing interlinear JSON: ${parseError.message}`);
                // logger.debug(`[Interlinear Command] Raw JSON string: ${interlinearDataJson}`); // Keep for debugging if needed
                return interaction.editReply({ content: 'Sorry, there was an error processing the interlinear data format from the source.', ephemeral: true });
            }

            // --- Process Interlinear and Strong's Data ---
            let originalVerseText = "";
            let transliterationText = "";
            const strongsEntries = []; // Array to hold { number: 'H123', word: '...', translit: '...', def: '...' }
            let languageType = ''; // 'Hebrew' or 'Greek' - determined by first valid entry

            const strongsProcessingPromises = interlinearItems.map(async (item) => {
                if (!item || typeof item.number !== 'string' || !item.number) return; // Skip invalid items

                originalVerseText += `${item.word || ''} | `;
                transliterationText += `${item.text || ''} | `;

                const match = item.number.match(/([HG])(\d+)/i);
                if (!match) return;

                const char = match[1].toUpperCase();
                const numbers = match[2];
                const currentLexicon = char === "G" ? "Greek" : "Hebrew";
                if (!languageType) languageType = currentLexicon;

                const strongsId = `${char}${numbers}`;

                try {
                    // Log the request being made
                    logger.debug(`[Interlinear Command] Requesting Strongs: ${strongsId} (Lexicon: ${currentLexicon})`);

                    const fetchTimeout = (ms, reason = `Strongs ${strongsId} timeout`) => new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));
                    const strongsData = await Promise.race([
                        strongsWrapper.getStrongsId(currentLexicon, strongsId),
                        fetchTimeout(STRONGS_FETCH_TIMEOUT_MS)
                    ]);

                    // Log the raw response data
                    logger.debug(`[Interlinear Command] Received Strongs data for ${strongsId}: ${JSON.stringify(strongsData)}`);

                    const translit = currentLexicon === "Greek" ? (strongsData?.translit) : (strongsData?.xlit);
                    const definition = strongsData?.strong_def || "No definition found.";

                    // Log if definition specifically is missing
                    if (!strongsData?.strong_def) {
                        logger.warn(`[Interlinear Command] strong_def missing for ${strongsId}. Raw data: ${JSON.stringify(strongsData)}`);
                    }

                    strongsEntries.push({
                        number: strongsId,
                        word: item.word || '',
                        translit: translit || 'N/A',
                        def: definition
                    });
                } catch (strongsError) {
                    // Ensure the specific error for this ID is logged clearly
                    logger.warn(`[Interlinear Command] Failed Strongs fetch for ${strongsId}: ${strongsError.message}`);
                    strongsEntries.push({
                        number: strongsId,
                        word: item.word || '',
                        translit: 'Error',
                        def: 'Error fetching definition.'
                    });
                }
            });

            // Wait for all Strong's fetches (or timeouts)
            await Promise.allSettled(strongsProcessingPromises);
            logger.info(`[Interlinear Command] Processed ${strongsEntries.length} Strong's entries.`);

            // --- Format Output ---
            const englishVerseText = englishVerseData[0]?.[translation] || `(${translation.toUpperCase()} translation not available)`;

            // Safely slice text for fields
            const sliceField = (text) => text.slice(0, EMBED_FIELD_VALUE_LIMIT - 10); // Leave buffer
            const formattedOriginal = `\\\`\\\`\\\`${sliceField(originalVerseText.slice(0, -3))}\\\`\\\`\\\``; // Remove trailing ' | '
            const formattedTranslit = `\\\`\\\`\\\`${sliceField(transliterationText.slice(0, -3))}\\\`\\\`\\\``;
            const translitDirection = languageType === "Hebrew" ? "(Right to Left)" : "(Left to Right)";

            // Paginate Strong's definitions
            const strongsPages = [];
            let currentPageText = "";
            for (const item of strongsEntries) {
                const entry = `• **${item.number}** - ${item.word} (${item.translit})\n  ${item.def}`;
                const potentialLength = currentPageText ? currentPageText.length + entry.length + 2 : entry.length; // +2 for \n\n

                if (currentPageText && potentialLength > STRONGS_PAGE_CHAR_LIMIT) {
                    strongsPages.push(currentPageText);
                    currentPageText = entry;
                } else {
                    currentPageText += (currentPageText ? "\n\n" : "") + entry;
                }
            }
            if (currentPageText) strongsPages.push(currentPageText);
            if (strongsPages.length === 0) strongsPages.push("No Strong's definitions could be processed or found.");

            const totalStrongsPages = strongsPages.length;
            let currentStrongsPage = 0;

            // --- Create Embed ---
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF; // Base 16 for hex
            const baseFooterText = `${process.env.EMBEDFOOTERTEXT} • ${bookName} ${chapter}:${verseInput}`; // Base footer

            const embed = new EmbedBuilder()
                .setTitle(`Interlinear: ${bookName} ${chapter}:${verseInput} (${translation.toUpperCase()})`)
                .setDescription(`*${translation.toUpperCase()} Translation*\n${englishVerseText}`)
                .addFields(
                    { name: `📜 Original ${languageType}`, value: formattedOriginal, inline: false },
                    { name: `🔄 Transliteration ${translitDirection}`, value: formattedTranslit, inline: false },
                    { name: "📚 Strong's Definitions", value: strongsPages[currentStrongsPage], inline: false }
                )
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(baseFooterText, currentStrongsPage, totalStrongsPages));

            // --- Send Response and Handle Pagination ---
            const message = await interaction.editReply({
                embeds: [embed],
                components: totalStrongsPages > 1 ? [createActionRow(currentStrongsPage, totalStrongsPages)] : []
            });

            if (totalStrongsPages <= 1) return; // No collector needed

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
                        currentStrongsPage = (currentStrongsPage - 1 + totalStrongsPages) % totalStrongsPages;
                    } else if (i.customId === 'page_next') {
                        currentStrongsPage = (currentStrongsPage + 1) % totalStrongsPages;
                    }

                    // Update the Strong's field value and footer
                    // Ensure the field exists before trying to modify it
                    if (embed.data.fields && embed.data.fields.length > 2) {
                        embed.data.fields[2].value = strongsPages[currentStrongsPage];
                    } else {
                        // Fallback or error handling if fields structure is unexpected
                        logger.error("[Interlinear Command] Embed fields structure incorrect during pagination.");
                        embed.spliceFields(2, 1, { name: "📚 Strong's Definitions", value: strongsPages[currentStrongsPage], inline: false });
                    }
                    embed.setFooter(generateFooter(baseFooterText, currentStrongsPage, totalStrongsPages));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentStrongsPage, totalStrongsPages)] });
                } catch (collectError) {
                    logger.error(`[Interlinear Command] Error updating pagination: ${collectError}`);
                    try { await i.followUp({ content: 'Error changing page.', ephemeral: true }); } catch { /* Ignore */ }
                }
            });

            collector.on('end', () => {
                logger.info(`[Interlinear Command] Pagination collector ended for ${bookName} ${chapter}:${verseInput}`);
                const timedOutRow = createActionRow(currentStrongsPage, totalStrongsPages, true); // Disable buttons
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    // Ignore error if message was deleted
                    if (editError.code !== 10008) {
                        logger.error(`[Interlinear Command] Error disabling buttons: ${editError}`);
                    }
                });
            });

        } catch (error) {
            logger.error(`[Interlinear Command] Unhandled error: ${error.message}`, error.stack);
            try {
                // Ensure we reply, even if deferred
                await interaction.editReply({ content: 'An unexpected error occurred. Please try again later.', embeds: [], components: [] }); // Clear components on error
            } catch (replyError) {
                // Ignore specific errors if interaction is no longer valid
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Interlinear Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
