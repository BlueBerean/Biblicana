const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const { bibleWrapper, numbersToBook, getBookId } = require('../utils/bibleHelper');
const VOTDData = require('../../data/VOTD.json');
require('dotenv').config();

// --- Constants ---
// Keep potentially useful constants if needed later, like timeouts for fetches
const VERSE_FETCH_TIMEOUT_MS = 6000;

function generateFooter(translation = "BSB") {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

// Function to parse reference string (e.g., "John 3:16", "1 Cor 13:4-7")
function parseVOTDReference(refString) {
    if (!refString) return null;

    // Regex to capture book name, chapter, start verse, and optional end verse
    // Allows for spaces and numbers in book names (e.g., "1 Corinthians")
    const match = refString.match(/^([1-3]?\s*[\w\s]+)\s+(\d+):(\d+)(?:-(\d+))?$/i);

    if (!match) {
        logger.warn(`[parseVOTDReference] Could not parse reference string: ${refString}`);
        return null;
    }

    const bookNameStr = match[1].trim();
    const chapterStr = match[2];
    const startVerseStr = match[3];
    const endVerseStr = match[4]; // Might be undefined

    const bookId = getBookId(bookNameStr);
    if (!bookId) {
        logger.warn(`[parseVOTDReference] Could not get bookId for book name: ${bookNameStr}`);
        return null;
    }

    const chapter = parseInt(chapterStr);
    const startVerse = parseInt(startVerseStr);
    const endVerse = endVerseStr ? parseInt(endVerseStr) : startVerse; // Default end to start if not present

    if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) {
        logger.warn(`[parseVOTDReference] Failed to parse chapter/verse numbers in: ${refString}`);
        return null;
    }

    return { bookId, chapter, startVerse, endVerse };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('passageoftheday')
        .setDescription('Get the Bible passage selected for today')
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show the passage in (defaults to BSB)')
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
                logger.error(`[PassageOfTheDay Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            // --- Get Today's Reference from VOTD.json ---
            const today = new Date();
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            const monthName = monthNames[today.getMonth()];
            const dayOfMonth = today.getDate().toString(); // Get day as string for JSON key

            const referenceString = VOTDData?.[monthName]?.[dayOfMonth];

            if (!referenceString) {
                logger.error(`[PassageOfTheDay Command] No reference found in VOTD.json for ${monthName} ${dayOfMonth}`);
                return interaction.editReply({ content: 'Sorry, could not find today\'s passage in the schedule.', ephemeral: true });
            }

            logger.info(`[PassageOfTheDay Command] Today's reference from JSON: ${referenceString}`);

            // --- Parse Reference ---
            const parsedRef = parseVOTDReference(referenceString);

            if (!parsedRef) {
                logger.error(`[PassageOfTheDay Command] Failed to parse reference string: ${referenceString}`);
                return interaction.editReply({ content: 'Sorry, there was an error understanding today\'s passage reference.', ephemeral: true });
            }

            const { bookId, chapter, startVerse, endVerse } = parsedRef;
            const bookName = numbersToBook.get(bookId); // We already validated bookId in parse function

            // --- Fetch Verse Text ---
            let verseTextResult;
            try {
                // Add a timeout for safety
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), VERSE_FETCH_TIMEOUT_MS);
                verseTextResult = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!verseTextResult || verseTextResult.length === 0) {
                    throw new Error('No verses returned from bibleWrapper');
                }
            } catch (fetchError) {
                logger.error(`[PassageOfTheDay Command] Error fetching verse text for ${bookName} ${chapter}:${startVerse}-${endVerse}: ${fetchError}`);
                return interaction.editReply({ content: 'Sorry, I couldn\'t fetch the text for today\'s passage.', ephemeral: true });
            }

            // --- Format Verse Text and Reference ---
            let formattedVerseText = "";
            let referenceDisplay = "";
            if (startVerse === endVerse) {
                referenceDisplay = `${bookName} ${chapter}:${startVerse}`;
                formattedVerseText = verseTextResult[0]?.[translation] || '(Translation not available)';
            } else {
                referenceDisplay = `${bookName} ${chapter}:${startVerse}-${endVerse}`;
                // Combine verses with verse numbers
                formattedVerseText = verseTextResult.map(v => `**${v.verse}** ${v[translation] || '(Translation missing)'}`).join(' ');
            }

            // Limit length just in case
            const MAX_DESC_LENGTH = 4000; // Keep under 4096 limit
            if (formattedVerseText.length > MAX_DESC_LENGTH) {
                formattedVerseText = formattedVerseText.substring(0, MAX_DESC_LENGTH - 3) + '...';
            }

            // --- Create Embed ---
            const dateString = today.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📖 Daily Bible Passage - ${dateString}`)
                .setDescription(`### ${referenceDisplay}\n\n*${formattedVerseText}*`)
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation));

            // --- Send Reply ---
            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error(`[PassageOfTheDay Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: '❌ Sorry, there was an unexpected error processing your request.',
                    ephemeral: true,
                    embeds: [], components: [] // Clear potentially broken reply
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[PassageOfTheDay Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
}; 