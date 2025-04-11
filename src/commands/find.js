const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType} = require('discord.js');
const swearWordFilter = require('../utils/filter');
const axios = require('axios');
const { numbersToBook, bibleWrapper, bookAbbreviations } = require("../utils/bibleHelper.js");
const logger = require('../utils/logger');

// Constants
const MAX_VERSES_PER_PAGE = 2;
const MAX_EMBED_CHARS = 1900;
const PAGINATION_TIMEOUT_MS = 900000; // 15 minutes
const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_MAX_TOKENS = 500;
const OPENAI_TEMPERATURE = 0.7;

function generateFooter(translation = "BSB", page, maxPages = 2) {
    return { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, iconURL: process.env.EMBEDICONURL };
}

function joinPage(page, maxChars) {
    return page.join("\n").slice(0, maxChars);
}

// Helper function to get verse references from OpenAI
async function fetchAndParseVerseReferences(topic) {
    const prompt = `You are a Bible verse finder. Please find5 to 10 relevant verses about "${topic}" and respond ONLY with a JSON array in this exact format: [{"book": "abbreviated_name", "chapter": "chapter_number", "startVerse": "verse_number", "endVerse": "verse_number"}]. Use only these abbreviated names: gen, exo, lev, num, deu, jos, jdg, rut, 1sa, 2sa, 1ki, 2ki, 1ch, 2ch, ezr, neh, est, job, psa, pro, ecc, sos, isa, jer, lam, eze, dan, hos, joe, amo, oba, jon, mic, nah, hab, zep, hag, zec, mal, mat, mar, luk, joh, act, rom, 1co, 2co, gal, eph, php, col, 1th, 2th, 1ti, 2ti, tit, phm, heb, jam, 1pe, 2pe, 1jo, 2jo, 3jo, jde, rev. If no relevant verses are found, return an empty JSON array []. Do not include any text before or after the JSON array.`;

    try {
        const apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            "model": OPENAI_MODEL,
            "messages": [{ "role": "user", "content": prompt }],
            "temperature": OPENAI_TEMPERATURE,
            "max_tokens": OPENAI_MAX_TOKENS
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAIKEY}`
            }
        });

        logger.info(`[Find Command] OpenAI raw response: ${JSON.stringify(apiResponse.data)}`);

        const content = apiResponse?.data?.choices?.[0]?.message?.content;
        if (!content) {
            logger.error('[Find Command] Invalid API response structure from OpenAI');
            throw new Error('Received an invalid response structure from the AI.');
        }

        // Attempt to parse the JSON response
        let parsedVerses;
        try {
            parsedVerses = JSON.parse(content.trim());
        } catch (parseError) {
            logger.error(`[Find Command] JSON parse error: ${parseError.message}. Content: "${content}"`);
            throw new Error('Received an incorrectly formatted response from the AI.');
        }

        // Validate the parsed structure
        if (!Array.isArray(parsedVerses)) {
             logger.error(`[Find Command] Parsed response is not an array. Content: "${content}"`);
             throw new Error('Received an unexpected response format from the AI.');
        }

        // Further validation: Check individual verse objects
        for (const verse of parsedVerses) {
            if (!verse || typeof verse !== 'object' || !verse.book || !verse.chapter || !verse.startVerse) {
                 logger.error(`[Find Command] Invalid verse object format in parsed response: ${JSON.stringify(verse)}`);
                 throw new Error('Received improperly structured verse data from the AI.');
            }
            // Check if book abbreviation is valid
             if (!bookAbbreviations.has(verse.book.toLowerCase())) {
                logger.warn(`[Find Command] OpenAI returned invalid book abbreviation: ${verse.book}`);
                // Optionally filter out invalid refs, or throw error depending on desired strictness
                // For now, we'll let it proceed and potentially fail later, logging the warning.
            }
        }


        logger.info(`[Find Command] Parsed verses: ${JSON.stringify(parsedVerses)}`);
        return parsedVerses; // Return the successfully parsed and validated array

    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error(`[Find Command] OpenAI API error: ${error.message}`);
            if (error.response) {
                logger.error(`[Find Command] OpenAI API error details: Status ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
            // Rethrow a more user-friendly error or specific error type
             throw new Error('Failed to communicate with the AI service.');
        }
        // Rethrow other errors (like parsing/validation errors)
        throw error;
    }
}

// Helper function to format verse descriptions
async function formatVerseDescriptions(parsedVerses, translation) {
    let description = [];
    let validVerseCount = 0;

    for (const verseRef of parsedVerses) {
        // Validate references before fetching
        const book = verseRef.book.toLowerCase();
        const bookId = bookAbbreviations.get(book);
        const chapter = parseInt(verseRef.chapter); // Ensure chapter is number
        const startVerse = parseInt(verseRef.startVerse);
        const endVerse = parseInt(verseRef.endVerse) || startVerse; // Default endVerse to startVerse if missing

        logger.info(`[Find Command] Processing verse reference - Book: ${book}, Chapter: ${chapter}, Verses: ${startVerse}-${endVerse}, BookId: ${bookId}`);

        // Strict validation
        if (!bookId || isNaN(chapter) || chapter <= 0 || isNaN(startVerse) || startVerse <= 0 || isNaN(endVerse) || endVerse < startVerse) {
            logger.warn(`[Find Command] Invalid verse data from AI - Ref: ${JSON.stringify(verseRef)}, Parsed: BookId=${bookId}, C=${chapter}, S=${startVerse}, E=${endVerse}`);
            continue; // Skip this invalid reference
        }

        try {
            let versesFromAPI = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);

            if (!versesFromAPI || versesFromAPI.length === 0) {
                logger.warn(`[Find Command] No verses returned from Bible API for ${book} ${chapter}:${startVerse}-${endVerse} (${translation})`);
                continue; // Skip if Bible API returns nothing for this valid reference
            }

            let verseText = versesFromAPI.map((verseData, index) => {
                const number = index + startVerse;
                // Ensure the translation exists in the returned data
                const text = verseData[translation];
                if (!text) {
                    logger.warn(`[Find Command] Translation '${translation}' not found for ${book} ${chapter}:${number}. Available: ${Object.keys(verseData)}`);
                    return `[Translation ${translation} not available]`;
                }
                return (index > 0 ? ` <**${number}**> ` : "") + text;
            }).join("");

            const prettyBookName = numbersToBook.get(bookId);
            const verseRange = startVerse === endVerse ? startVerse : `${startVerse}-${endVerse}`;

            description.push(`**${prettyBookName} ${chapter}:${verseRange}**: ${verseText}\n`);
            validVerseCount++;

        } catch (bibleApiError) {
            logger.error(`[Find Command] Error fetching from Bible API for ${book} ${chapter}:${startVerse}-${endVerse}: ${bibleApiError.message}`);
            // Decide whether to continue or stop; continuing allows partial results
            continue;
        }
    }

    return { description, validVerseCount };
}

// Helper function to send paginated reply
async function sendPaginatedReply(interaction, embed, description, translation, requestedTopic) {
    let pages = [];
    let tempArr = [];
    for (const verse of description) {
        if (tempArr.length === MAX_VERSES_PER_PAGE) {
            pages.push(tempArr);
            tempArr = [];
        }
        tempArr.push(verse);
    }
    if (tempArr.length > 0) {
        pages.push(tempArr);
    }

    if (pages.length <= 1) { // Handle single page case within this function
        const defaultFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`, iconURL: process.env.EMBEDICONURL };
        embed.setFooter(defaultFooter).setDescription(joinPage(pages[0] || [], MAX_EMBED_CHARS)); // Use pages[0] or empty array

        const disclaimerButton = new ButtonBuilder()
            .setStyle(ButtonStyle.Secondary)
            .setLabel("💡 Disclaimer")
            .setCustomId("bias_alert");
        const row = new ActionRowBuilder().addComponents(disclaimerButton);

        const replyMessage = await interaction.editReply({ embeds: [embed], components: [row], fetchReply: true });

        const singlePageCollector = replyMessage.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: PAGINATION_TIMEOUT_MS
        });

        singlePageCollector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                try { await i.deferUpdate(); } catch (e) {
                    logger.warn(`[Find Command] Failed to defer user check interaction: ${e.message}`);
                }
                await i.followUp({ content: 'You cannot use this button.', ephemeral: true });
                return;
            }
        });

        singlePageCollector.on('end', _collected => {
            logger.info(`[Find Command] Disclaimer collector ended for single-page topic "${requestedTopic}".`);
             _collected; // Explicitly reference to potentially satisfy linter
            interaction.editReply({ embeds: [embed], components: [] })
                .catch(editError => {
                    logger.warn(`[Find Command] Failed to remove disclaimer button after timeout: ${editError.message}`);
                });
        });

        return; // End execution for single page
    }

    // Multi-page logic
    const paginationButtons = [
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setEmoji("◀️").setLabel("Previous").setCustomId("page_back"),
        new ButtonBuilder().setStyle(ButtonStyle.Secondary).setEmoji("▶️").setLabel("Next").setCustomId("page_next"),
    ];
    const actionRow = new ActionRowBuilder().addComponents(...paginationButtons);
    const disclaimerButton = new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("💡 Disclaimer").setCustomId("bias_alert");
    const secondRow = new ActionRowBuilder().addComponents(disclaimerButton);

    let currentPage = 0;

    const messagePayload = {
        embeds: [embed.setFooter(generateFooter(translation, currentPage, pages.length)).setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS))],
        components: [actionRow, secondRow],
        fetchReply: true
    };

    const replyMessage = await interaction.editReply(messagePayload);

    const collector = replyMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: PAGINATION_TIMEOUT_MS
    });

    collector.on('collect', async i => {
        if (i.user.id !== interaction.user.id) {
            try { await i.deferUpdate(); } catch (e) {
                logger.warn(`[Find Command] Failed to defer user check interaction: ${e.message}`);
            }
            await i.followUp({ content: 'You cannot use this button.', ephemeral: true });
            return;
        }

        try {
            await i.deferUpdate(); // Acknowledge pagination click (deferUpdate is better than deferReply here)

            if (i.customId === 'page_next') {
                currentPage = (currentPage + 1) % pages.length;
            } else if (i.customId === 'page_back') {
                currentPage = (currentPage - 1 + pages.length) % pages.length;
            }

            // Update embed with new page content
             const updatedEmbed = EmbedBuilder.from(embed) // Create from existing to keep title, color etc.
                 .setFooter(generateFooter(translation, currentPage, pages.length))
                 .setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS));

            await i.editReply({
                embeds: [updatedEmbed],
                components: [actionRow, secondRow] // Keep both rows
            });
        } catch (updateError) {
            logger.warn(`[Find Command] Failed to update interaction after pagination: ${updateError.message} (Code: ${updateError.code})`);
        }
    });

    collector.on('end', collected => {
        logger.info(`[Find Command] Pagination collector ended for topic "${requestedTopic}". Collected ${collected.size} interactions.`);
         const finalEmbed = EmbedBuilder.from(embed)
            .setFooter(generateFooter(translation, currentPage, pages.length) + ' | Buttons inactive')
            .setDescription(joinPage(pages[currentPage], MAX_EMBED_CHARS));

        interaction.editReply({ embeds: [finalEmbed], components: [] })
            .catch(editError => {
                logger.warn(`[Find Command] Failed to edit message after collector timeout: ${editError.message}`);
            });
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find a specific verse related to a topic')
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a verse for').setRequired(true).setMinLength(3).setMaxLength(250))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
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
        const requestedTopic = swearWordFilter(interaction.options.getString('topic')); // Filter topic early
        logger.info(`[Find Command] User ${interaction.user.id} searching for topic: "${requestedTopic}"`);

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            logger.info(`[Find Command] Using translation: ${translation}`);


            // --- Refactored OpenAI Interaction ---
            let parsedVerses;
            try {
                 parsedVerses = await fetchAndParseVerseReferences(requestedTopic);
            } catch (error) {
                 logger.error(`[Find Command] Error fetching/parsing verses: ${error.message}`);
                 // Provide more specific feedback based on the error thrown by fetchAndParseVerseReferences
                 return interaction.editReply({ content: `⚠️ Sorry, I encountered an issue while trying to understand the AI's response for "${requestedTopic}". Please try again. (${error.message})` });
            }

            if (!parsedVerses || parsedVerses.length === 0) {
                logger.info(`[Find Command] No relevant verses found by AI for topic: ${requestedTopic}`);
                return interaction.editReply({ content: `ℹ️ I couldn't find any specific verses directly related to "${requestedTopic}". Perhaps try rephrasing your topic?` });
            }
            // --- End Refactored Section ---


            // --- Format Verse Descriptions ---
            const { description, validVerseCount } = await formatVerseDescriptions(parsedVerses, translation);

            // Check if *any* verses were successfully processed
             if (validVerseCount === 0) {
                logger.warn(`[Find Command] No valid verses could be fetched or formatted for topic: ${requestedTopic}, despite AI providing references.`);
                return interaction.editReply({ content: `⚠️ Although the AI suggested some verses for "${requestedTopic}", I couldn't retrieve or format them correctly. Please try again later.` });
            }
            // --- End Formatting ---


            // Safer Embed Color Parsing (assuming hex like #RRGGBB or RRGGBB)
             let embedColor = 0x0099FF; // Default color
            if (process.env.EMBEDCOLOR) {
                try {
                    embedColor = parseInt(process.env.EMBEDCOLOR.replace(/^#/, ''), 16);
                 } catch (e) {
                     logger.warn(`[Find Command] Invalid EMBEDCOLOR format: ${process.env.EMBEDCOLOR}. Using default.`);
                 }
            }


            const embed = new EmbedBuilder()
                .setTitle(`Verses regarding "${requestedTopic}"`)
                .setColor(embedColor) // Use parsed color
                .setURL(process.env.WEBSITE);

            logger.debug(`Embed color being used: ${embedColor.toString(16)}`);

            // --- Send Paginated Reply ---
            await sendPaginatedReply(interaction, embed, description, translation, requestedTopic);
            // --- End Reply Section ---

        } catch (error) {
            // Catch any unexpected errors not handled earlier
            logger.error(`[Find Command] Unhandled error in execute: ${error.message}`);
            logger.error(error.stack);
            // Check if reply already sent/deferred before sending another
             if (!interaction.replied && !interaction.deferred) {
                 await interaction.reply({ content: '⚠️ An unexpected error occurred while processing your request.', ephemeral: true });
             } else {
                 await interaction.editReply({ content: '⚠️ An unexpected error occurred while processing your request.' });
             }
        }
    },
};