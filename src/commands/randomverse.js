const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const { getBookId, numbersToBook, bibleWrapper } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
const swearWordFilter = require('../utils/filter');
require('dotenv').config();

// --- Constants ---
const API_TIMEOUT_MS = 6000;

// --- Helper Functions ---

// Standard footer generation
function generateFooter(translation = "BSB") {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`,
        iconURL: process.env.EMBEDICONURL
    };
}

// Removed unused createVerseEmbed function

// --- Command Export ---
module.exports = {
    data: new SlashCommandBuilder()
        .setName('randomverse')
        .setDescription('Get a random Bible verse')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Limit to a specific book (optional)')
                .setRequired(false))
        .addNumberOption(option =>
            option.setName('chapter')
                .setDescription('Limit to a specific chapter (requires book)')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use (defaults to BSB)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            // --- Determine Translation ---
            let translation = 'BSB'; // Default
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[RandomVerse Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            // --- Handle Optional Filters ---
            let bookId = null;
            let chapter = null;
            const rawBookInput = interaction.options.getString('book');
            if (rawBookInput) {
                const rawBook = swearWordFilter(rawBookInput.trim());
                if (rawBook) {
                    bookId = getBookId(rawBook);
                    if (!bookId) {
                        return interaction.editReply({
                            content: `I couldn't find the book "${rawBookInput}". Please check the spelling or try using the full book name.`,
                            ephemeral: true
                        });
                    }

                    const chapterInput = interaction.options.getNumber('chapter');
                    if (chapterInput !== null) { // Allow chapter 0 if API supports? Assuming 1+ based on setMinValue
                        chapter = chapterInput; // Already validated by setMinValue(1)
                        if (isNaN(chapter) || chapter < 1) { // Double check, should be redundant
                            return interaction.editReply({ content: 'Please provide a valid chapter number (1 or greater).', ephemeral: true });
                        }
                    }
                }
            }

            // --- Fetch Random Verse Reference from API ---
            const apiOptions = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetRandomVerse',
                params: {
                    versionId: 'kjv' // Always use KJV for getting the verse ID
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            // Add filters if specified
            if (bookId) {
                apiOptions.params.limitToBookId = bookId.toString().padStart(2, '0');
                if (chapter) {
                    apiOptions.params.limitToChapterId = chapter.toString().padStart(3, '0'); // Assuming API expects chapter padded
                }
            }

            logger.info(`[RandomVerse Command] Fetching random verse reference with params:`, apiOptions.params);
            let randomVerseData;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
                const response = await axios.request({...apiOptions, signal: controller.signal });
                clearTimeout(timeoutId);

                logger.debug("[RandomVerse Command] Raw API response:", JSON.stringify(response.data));

                if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
                    throw new Error('API response was empty or not an array');
                }
                randomVerseData = response.data[0]; // Take the first verse returned

                // Validate essential fields from API
                if (!randomVerseData || !randomVerseData.b || !randomVerseData.c || !randomVerseData.v) {
                    logger.error("[RandomVerse Command] API response missing required fields (b, c, v):", randomVerseData);
                    throw new Error('API response missing required reference fields');
                }

            } catch (apiError) {
                logger.error(`[RandomVerse Command] API request failed: ${apiError.message}`);
                if (apiError.response) {
                    logger.error(`[RandomVerse Command] API Status: ${apiError.response.status}, Data: ${JSON.stringify(apiError.response.data)}`);
                }
                const userMessage = apiError.response?.status === 404
                    ? 'No verse found matching the specified criteria (book/chapter). Please broaden your search.'
                    : 'Unable to fetch a random verse from the source. Please try again later.';
                return interaction.editReply({ content: userMessage, ephemeral: true });
            }

            // --- Parse Reference & Fetch Text ---
            const parsedBookId = parseInt(randomVerseData.b);
            const parsedChapter = parseInt(randomVerseData.c);
            const parsedVerse = parseInt(randomVerseData.v);
            const bookName = numbersToBook.get(parsedBookId);

            if (isNaN(parsedBookId) || isNaN(parsedChapter) || isNaN(parsedVerse) || !bookName) {
                logger.error(`[RandomVerse Command] Failed to parse valid reference from API: b=${randomVerseData.b}, c=${randomVerseData.c}, v=${randomVerseData.v}`);
                return interaction.editReply({ content: 'Received an invalid verse reference from the source.', ephemeral: true });
            }

            let verseDbResult;
            try {
                verseDbResult = await bibleWrapper.getVerses(parsedBookId, parsedChapter, parsedVerse, parsedVerse);
            } catch (dbError) {
                logger.error(`[RandomVerse Command] Database error fetching ${bookName} ${parsedChapter}:${parsedVerse}: ${dbError}`);
                return interaction.editReply({ content: 'Error retrieving verse text from database.', ephemeral: true });
            }

            if (!verseDbResult || verseDbResult.length === 0) {
                logger.error(`[RandomVerse Command] Verse not found in DB: ${bookName} ${parsedChapter}:${parsedVerse}`);
                return interaction.editReply({ content: 'Verse reference found, but text could not be retrieved from database.', ephemeral: true });
            }

            // --- Determine Final Text and Format Embed ---
            let verseText = verseDbResult[0][translation];
            let usedTranslation = translation;

            // Fallback to KJV from API if preferred translation failed
            if (!verseText) {
                logger.warn(`[RandomVerse Command] Translation ${translation} not found in DB for ${bookName} ${parsedChapter}:${parsedVerse}, falling back to KJV from API.`);
                verseText = randomVerseData.t; // KJV text from the API response
                usedTranslation = 'KJV'; // Indicate KJV was used
            }

            if (!verseText) { // If even KJV fallback is missing
                logger.error(`[RandomVerse Command] No usable verse text found for ${bookName} ${parsedChapter}:${parsedVerse}`);
                return interaction.editReply({ content: 'Could not find any text for the selected verse.', ephemeral: true });
            }

            logger.info(`[RandomVerse Command] Displaying: ${bookName} ${parsedChapter}:${parsedVerse} (${usedTranslation})`);

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
            const embed = new EmbedBuilder()
                .setTitle(`${bookName} ${parsedChapter}:${parsedVerse}`)
                .setDescription(`<**${parsedVerse}**> ${verseText}`)
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(usedTranslation)); // Show the translation actually used

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`[RandomVerse Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: '❌ Sorry, there was an unexpected error processing your request.',
                    ephemeral: true,
                    embeds: [], components: []
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[RandomVerse Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
}; 