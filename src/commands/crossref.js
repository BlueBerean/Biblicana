const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const { getBookId, bibleWrapper, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

// Constants
const MAX_CHARS_PER_PAGE = 4000; // Discord embed description limit is 4096
const COLLECTOR_TIMEOUT_MS = 600_000; // 10 minutes

// Helper to generate embed footer
function generateFooter(translation = "BSB", page, maxPages) {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

// Helper to create the action row with buttons
const createActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('◀️')
            .setLabel('Previous') // Added labels for clarity
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('▶️')
            .setLabel('Next') // Added labels for clarity
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === totalPages - 1)
    );

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crossref')
        .setDescription('Find cross-references for a Bible verse')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book of the Bible')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1)) // Verse validation
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Bible translation to use (defaults to your saved preference or BSB)')
                // Add more choices if needed, ensure they match bibleWrapper keys
                .addChoices(
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
            // Determine translation (user input > database preference > default)
            let translation = 'BSB'; // Default
            try {
                 const userPref = await database.getUserValue(interaction.user.id);
                 if (userPref?.translation) {
                    translation = userPref.translation;
                 }
            } catch (dbError) {
                logger.error(`[Crossref Command] Failed to get user preference from DB: ${dbError}`);
                // Continue with default BSB, no need to inform user
            }
            translation = interaction.options.getString('translation') || translation;
            
            const rawBook = interaction.options.getString('book');
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');

            // Validate chapter
            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ 
                    content: 'Please provide a valid chapter number (must be 1 or greater).',
                    ephemeral: true 
                });
            }

            // Validate verse
            if (verseInput === null || !Number.isInteger(verseInput) || verseInput < 1) {
                 return interaction.editReply({
                    content: 'Please provide a valid verse number (must be a whole number, 1 or greater).',
                    ephemeral: true
                });
            }
            const verse = verseInput;

            // Get book ID and name
            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);
            if (!bookId) {
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                    ephemeral: true 
                });
            }

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}`;
            logger.info(`[Crossref Command] Looking up cross-refs for ${bookName} ${chapter}:${verse} (ID: ${verseId}, Translation: ${translation})`);

            // Fetch cross-references and original verse text concurrently
            const apiOptions = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetCrossReferences',
                params: { verseId },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const [crossRefResponse, originalVerseData] = await Promise.allSettled([
                axios.request(apiOptions),
                bibleWrapper.getVerses(bookId, chapter, verse, verse) // Fetch original verse
            ]);

            // Handle failed original verse fetch
            if (originalVerseData.status === 'rejected' || !originalVerseData.value || originalVerseData.value.length === 0 || !originalVerseData.value[0][translation]) {
                logger.error(`[Crossref Command] Failed to fetch original verse ${bookName} ${chapter}:${verse} (Translation: ${translation}): ${originalVerseData.reason || 'Not Found'}`);
                return interaction.editReply({ content: `Sorry, I couldn't fetch the text for the original verse (${bookName} ${chapter}:${verse} - ${translation}). Please ensure the translation is available for this verse.`, ephemeral: true });
            }
            const originalVerseText = originalVerseData.value[0][translation];
            const originalVerseRef = `**📍 ${bookName} ${chapter}:${verse} (${translation.toUpperCase()})**`;

            // Handle failed cross-ref fetch or no results
            if (crossRefResponse.status === 'rejected' || !crossRefResponse.value?.data || crossRefResponse.value.data.length === 0) {
                logger.warn(`[Crossref Command] No cross-references found or API error for ${verseId}: ${crossRefResponse.reason || 'Empty Response'}`);
                 const noRefsEmbed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(`${originalVerseRef}\n${originalVerseText}\n\nNo cross-references found for this verse.`)
                    .setColor(0x0099FF) // Use a default color
                    .setURL(process.env.WEBSITE)
                    .setFooter({ text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL });
                return interaction.editReply({ embeds: [noRefsEmbed] });
            }

            const crossRefs = crossRefResponse.value.data;

            // Process cross-references - fetch text for each
            // Potential Optimization: If bibleWrapper supports batch fetching, use it here.
            const processedRefs = (await Promise.allSettled(crossRefs.map(async ref => {
                const refBookId = parseInt(ref.sv.slice(0, 2));
                const refChapter = parseInt(ref.sv.slice(2, 5));
                const refVerse = parseInt(ref.sv.slice(5));
                const refBookName = numbersToBook.get(refBookId);

                if (!refBookName) return null; // Skip if book ID is invalid

                const verseData = await bibleWrapper.getVerses(refBookId, refChapter, refVerse, refVerse);
                const verseText = verseData?.[0]?.[translation];

                if (!verseText) return null; // Skip if text not found for the translation

                return `• **${refBookName} ${refChapter}:${refVerse}** - ${verseText}\n`;
            })))
            .filter(result => result.status === 'fulfilled' && result.value)
            .map(result => result.value);

            if (processedRefs.length === 0) {
                logger.warn(`[Crossref Command] Found cross-ref IDs, but failed to fetch text for any in ${translation} for ${verseId}`);
                const noTextEmbed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(`${originalVerseRef}\n${originalVerseText}\n\nCross-references were found, but I couldn't retrieve their text in the ${translation.toUpperCase()} translation.`)
                    .setColor(0x0099FF)
                    .setURL(process.env.WEBSITE)
                    .setFooter({ text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL });
                return interaction.editReply({ embeds: [noTextEmbed] });
            }

            // Create pages
            const pages = [];
            let currentPageContent = `${originalVerseRef}\n${originalVerseText}\n\n**🔗 Cross References:**\n`;

            for (const refText of processedRefs) {
                if ((currentPageContent + refText).length > MAX_CHARS_PER_PAGE) {
                    pages.push(currentPageContent.trim());
                    // Start new page with original verse context for clarity
                    currentPageContent = `${originalVerseRef}\n*Continued...*\n\n**🔗 Cross References:**\n${refText}`;
                } else {
                    currentPageContent += refText;
                }
            }
            pages.push(currentPageContent.trim()); // Add the last page

             // Use parseInt for safer color handling, provide a default
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR) : 0x0099FF;

                const embed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(pages[0])
                .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, 0, pages.length));

            if (pages.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            // Send paginated response
            let currentPageIndex = 0;
            const message = await interaction.editReply({ 
                embeds: [embed], 
                components: [createActionRow(currentPageIndex, pages.length)]
            });

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                 try {
                    await i.deferUpdate();
                if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % pages.length;
                } else if (i.customId === 'page_back') {
                        currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                    }

                embed.setDescription(pages[currentPageIndex])
                     .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                } catch (collectError) {
                    logger.error(`[Crossref Command] Error updating pagination: ${collectError}`);
                    // Attempt to notify user
                    try {
                         await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                    } catch { /* Ignore follow-up error */ }
                }
            });

            collector.on('end', () => {
                logger.info(`[Crossref Command] Pagination collector ended for ${bookName} ${chapter}:${verse}`);
                const timedOutRow = createActionRow(currentPageIndex, pages.length, true); // Disable buttons
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    logger.error(`[Crossref Command] Error disabling buttons after timeout: ${editError}`);
                });
            });

        } catch (error) {
            logger.error(`[Crossref Command] Error: ${error.message}`, error.stack);
            if (error.response) {
                logger.error(`[Crossref Command] API Error Status: ${error.response.status}`);
                logger.error(`[Crossref Command] API Error Data: ${JSON.stringify(error.response.data)}`);
            }
             try {
            await interaction.editReply({ 
                    content: 'Sorry, there was an error processing your cross-reference request. Please try again later.',
                ephemeral: true 
            });
            } catch (replyError) {
                logger.error(`[Crossref Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
}; 