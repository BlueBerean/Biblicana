const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const { getBookId, bibleWrapper, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
const swearWordFilter = require('../utils/filter');
const splitString = require('../utils/splitString');
require('dotenv').config();

const MAX_CHARS_PER_PAGE = 4000;
const COLLECTOR_TIMEOUT_MS = 600_000;

function generateFooter(topTranslation = "BSB", page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Top Translation: ${topTranslation.toUpperCase()}${pageText}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

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
        .setName('parallel')
        .setDescription('View a verse in multiple parallel Bible translations')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book name or abbreviation')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The primary translation to display at the top (defaults to BSB)')
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
            const rawBookInput = interaction.options.getString('book').trim();
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');
            const rawBook = swearWordFilter(rawBookInput);

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ content: 'Invalid chapter number provided.', ephemeral: true });
            }

            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);
            if (!bookId || !bookName) {
                logger.warn(`[Parallel Command] Invalid book: ${rawBook}`);
                return interaction.editReply({ content: `Invalid book: "${rawBook}".`, ephemeral: true });
            }

            let primaryTranslation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) primaryTranslation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Parallel Command] Failed to get user preference: ${dbError}`);
            }
            primaryTranslation = interaction.options.getString('translation') || primaryTranslation;

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verseInput.toString().padStart(3, '0')}`;
            logger.info(`[Parallel Command] Request: ${bookName} ${chapter}:${verseInput} (ID: ${verseId}, Primary: ${primaryTranslation})`);

            const apiOptions = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetParallelVerses',
                params: { verseId },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const [parallelResult, originalVerseResult] = await Promise.allSettled([
                axios.request(apiOptions),
                bibleWrapper.getVerses(bookId, chapter, verseInput, verseInput)
            ]);

            if (originalVerseResult.status === 'rejected' || !originalVerseResult.value || originalVerseResult.value.length === 0 || !originalVerseResult.value[0][primaryTranslation]) {
                const reason = originalVerseResult.reason?.message || 'Not Found or Translation Unavailable';
                logger.error(`[Parallel Command] Failed to fetch original verse ${bookName} ${chapter}:${verseInput} (${primaryTranslation}): ${reason}`);
                return interaction.editReply({ content: `Sorry, I couldn't fetch the text for the primary verse (${bookName} ${chapter}:${verseInput} - ${primaryTranslation}). ${reason}`, ephemeral: true });
            }
            const originalVerseText = originalVerseResult.value[0][primaryTranslation];

            if (parallelResult.status === 'rejected') {
                logger.error(`[Parallel Command] API request failed for verse ID ${verseId}: ${parallelResult.reason?.message}`);
                if (parallelResult.reason?.response) {
                    logger.error(`[Parallel Command] API Error Status: ${parallelResult.reason.response.status}`);
                    logger.error(`[Parallel Command] API Error Data: ${JSON.stringify(parallelResult.reason.response.data)}`);
                }
                return interaction.editReply({ content: 'Sorry, failed to connect to the parallel translations source.', ephemeral: true });
            }

            const parallelData = parallelResult.value?.data;
            logger.debug("[Parallel Command] Raw API Response Data:", JSON.stringify(parallelData));

            if (!Array.isArray(parallelData) || parallelData.length === 0) {
                logger.warn(`[Parallel Command] No parallel translations found or invalid format for ${verseId}`);
                const noParallelEmbed = new EmbedBuilder()
                    .setTitle(`Parallel Translations - ${bookName} ${chapter}:${verseInput}`)
                    .setDescription(`**${bookName} ${chapter}:${verseInput} (${primaryTranslation.toUpperCase()})**\n${originalVerseText}\n\n*No other parallel translations were found for this verse.*`)
                    .setColor(0x0099FF)
                    .setURL(process.env.WEBSITE)
                    .setFooter(generateFooter(primaryTranslation, 0, 1));
                return interaction.editReply({ embeds: [noParallelEmbed] });
            }

            let combinedContent = `**${bookName} ${chapter}:${verseInput} (${primaryTranslation.toUpperCase()})**\n${originalVerseText}\n\n**Parallel Translations:**\n`;
            let validTranslationsCount = 0;

            for (const translationEntry of parallelData) {
                if (Array.isArray(translationEntry) && translationEntry.length > 0 && typeof translationEntry[0] === 'object' && translationEntry[0] !== null) {
                    const version = translationEntry[0];
                    if (version.versionAbbreviation && version.t) {
                        if (version.versionAbbreviation.toUpperCase() !== primaryTranslation.toUpperCase()) {
                            combinedContent += `• **${version.versionAbbreviation.toUpperCase()}**: ${version.t}\n`;
                            validTranslationsCount++;
                        }
                    } else {
                        logger.warn("[Parallel Command] Invalid translation object structure:", JSON.stringify(version));
                    }
                } else {
                    logger.warn("[Parallel Command] Unexpected entry format in parallel data array:", JSON.stringify(translationEntry));
                }
            }

            if (validTranslationsCount === 0) {
                logger.warn(`[Parallel Command] API returned data, but no valid parallel translations found for ${verseId} after filtering.`);
                const noValidParallelEmbed = new EmbedBuilder()
                    .setTitle(`Parallel Translations - ${bookName} ${chapter}:${verseInput}`)
                    .setDescription(`**${bookName} ${chapter}:${verseInput} (${primaryTranslation.toUpperCase()})**\n${originalVerseText}\n\n*No other valid parallel translations were found after processing.*`)
                    .setColor(0x0099FF)
                    .setURL(process.env.WEBSITE)
                    .setFooter(generateFooter(primaryTranslation, 0, 1));
                return interaction.editReply({ embeds: [noValidParallelEmbed] });
            }

            const pages = splitString(combinedContent, MAX_CHARS_PER_PAGE);

            if (pages.length === 0) {
                logger.error("[Parallel Command] Failed to create pages from combined content.");
                return interaction.editReply({ content: 'Sorry, an error occurred while formatting the parallel translations.', ephemeral: true });
            }

            let currentPageIndex = 0;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`Parallel Translations - ${bookName} ${chapter}:${verseInput}`)
                .setDescription(pages[currentPageIndex])
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(primaryTranslation, currentPageIndex, pages.length));

            const message = await interaction.editReply({
                embeds: [embed],
                components: pages.length > 1 ? [createActionRow(currentPageIndex, pages.length)] : []
            });

            if (pages.length <= 1) return;

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
                        currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                    } else if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % pages.length;
                    }

                    embed.setDescription(pages[currentPageIndex])
                         .setFooter(generateFooter(primaryTranslation, currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                } catch (collectError) {
                    logger.error(`[Parallel Command] Error updating pagination: ${collectError}`);
                    try { await i.followUp({ content: 'Error changing page.', ephemeral: true }); } catch (followUpError) {
                        logger.warn(`[Parallel Command] Failed to send follow-up pagination error: ${followUpError.message}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[Parallel Command] Pagination collector ended for ${bookName} ${chapter}:${verseInput}`);
                const timedOutRow = createActionRow(currentPageIndex, pages.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    if (editError.code !== 10008) {
                        logger.error(`[Parallel Command] Error disabling buttons: ${editError}`);
                    }
                });
            });

        } catch (error) {
            logger.error(`[Parallel Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: 'An unexpected error occurred. Please try again later.', embeds: [], components: [] });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Parallel Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
}; 