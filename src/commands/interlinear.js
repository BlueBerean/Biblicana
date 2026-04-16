import { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { bibleWrapper, strongsWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const VERSE_FETCH_TIMEOUT_MS = 6000;
const STRONGS_FETCH_TIMEOUT_MS = 5000;
const COLLECTOR_TIMEOUT_MS = 600_000;
const STRONGS_PAGE_CHAR_LIMIT = 1000;
const EMBED_FIELD_VALUE_LIMIT = 1024;

function generateFooter(textPrefix, page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return {
        text: `${textPrefix}${pageText}`,
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

export default {
    data: new SlashCommandBuilder()
        .setName('interlinear')
        .setDescription('Get an interlinear view of a specific Bible verse')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
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
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Parallel translation (defaults to your preference or BSB)')
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
            const rawBookInput = interaction.options.getString('book').trim();
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');
            const rawBook = swearWordFilter(rawBookInput);

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ content: 'Invalid chapter number provided.', flags: MessageFlags.Ephemeral });
            }

            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);
            if (!bookId || !bookName) {
                logger.warn(`[Interlinear Command] Invalid book: ${rawBook}`);
                return interaction.editReply({ content: `Invalid book: "${rawBook}". Use names like Genesis, John, 1 Corinthians, or abbreviations like gen, jn, 1co.`, flags: MessageFlags.Ephemeral });
            }

            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Interlinear Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            logger.info(`[Interlinear Command] Request: ${bookName} ${chapter}:${verseInput} (${translation})`);

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
                return interaction.editReply({ content: `Sorry, I couldn't fetch the required verse data (${fetchError.message}). Please check the reference or try again later.`, flags: MessageFlags.Ephemeral });
            }

            let interlinearItems;
            try {
                interlinearItems = JSON.parse(interlinearDataJson);
                if (!Array.isArray(interlinearItems) || interlinearItems.length === 0) {
                    throw new Error('Parsed data is not a valid array or is empty.');
                }
            } catch (parseError) {
                logger.error(`[Interlinear Command] Error parsing interlinear JSON: ${parseError.message}`);
                return interaction.editReply({ content: 'Sorry, there was an error processing the interlinear data format from the source.', flags: MessageFlags.Ephemeral });
            }

            let originalVerseText = "";
            let transliterationText = "";
            const strongsEntries = [];
            let languageType = '';

            const strongsProcessingPromises = interlinearItems.map(async (item) => {
                if (!item || typeof item.number !== 'string' || !item.number) return;

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
                    logger.debug(`[Interlinear Command] Requesting Strongs: ${strongsId} (Lexicon: ${currentLexicon})`);

                    const fetchTimeout = (ms, reason = `Strongs ${strongsId} timeout`) => new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));
                    const strongsData = await Promise.race([
                        strongsWrapper.getStrongsId(currentLexicon, strongsId),
                        fetchTimeout(STRONGS_FETCH_TIMEOUT_MS)
                    ]);

                    logger.debug(`[Interlinear Command] Received Strongs data for ${strongsId}: ${JSON.stringify(strongsData)}`);

                    const translit = currentLexicon === "Greek" ? (strongsData?.translit) : (strongsData?.xlit);
                    const definition = strongsData?.strong_def || "No definition found.";

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
                    logger.warn(`[Interlinear Command] Failed Strongs fetch for ${strongsId}: ${strongsError.message}`);
                    strongsEntries.push({
                        number: strongsId,
                        word: item.word || '',
                        translit: 'Error',
                        def: 'Error fetching definition.'
                    });
                }
            });

            await Promise.allSettled(strongsProcessingPromises);
            logger.info(`[Interlinear Command] Processed ${strongsEntries.length} Strong's entries.`);

            const englishVerseText = englishVerseData[0]?.[translation] || `(${translation.toUpperCase()} translation not available)`;

            const sliceField = (text) => text.slice(0, EMBED_FIELD_VALUE_LIMIT - 10);
            const formattedOriginal = `\`\`\`${sliceField(originalVerseText.slice(0, -3))}\`\`\``;
            const formattedTranslit = `\`\`\`${sliceField(transliterationText.slice(0, -3))}\`\`\``;
            const translitDirection = languageType === "Hebrew" ? "(Right to Left)" : "(Left to Right)";

            const strongsPages = [];
            let currentPageText = "";
            for (const item of strongsEntries) {
                const entry = `• **${item.number}** - ${item.word} (${item.translit})\n  ${item.def}`;
                const potentialLength = currentPageText ? currentPageText.length + entry.length + 2 : entry.length;

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

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
            const baseFooterText = `${process.env.EMBEDFOOTERTEXT} • ${bookName} ${chapter}:${verseInput}`;

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

            const message = await interaction.editReply({
                embeds: [embed],
                components: totalStrongsPages > 1 ? [createActionRow(currentStrongsPage, totalStrongsPages)] : []
            });

            if (totalStrongsPages <= 1) return;

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

                    if (embed.data.fields && embed.data.fields.length > 2) {
                        embed.data.fields[2].value = strongsPages[currentStrongsPage];
                    } else {
                        logger.error("[Interlinear Command] Embed fields structure incorrect during pagination.");
                        embed.spliceFields(2, 1, { name: "📚 Strong's Definitions", value: strongsPages[currentStrongsPage], inline: false });
                    }
                    embed.setFooter(generateFooter(baseFooterText, currentStrongsPage, totalStrongsPages));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentStrongsPage, totalStrongsPages)] });
                } catch (collectError) {
                    logger.error(`[Interlinear Command] Error updating pagination: ${collectError}`);
                    try { await i.followUp({ content: 'Error changing page.', flags: MessageFlags.Ephemeral }); } catch { /* Ignore */ }
                }
            });

            collector.on('end', () => {
                logger.info(`[Interlinear Command] Pagination collector ended for ${bookName} ${chapter}:${verseInput}`);
                const timedOutRow = createActionRow(currentStrongsPage, totalStrongsPages, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    if (editError.code !== 10008) {
                        logger.error(`[Interlinear Command] Error disabling buttons: ${editError}`);
                    }
                });
            });
        } catch (error) {
            logger.error(`[Interlinear Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: 'An unexpected error occurred. Please try again later.', embeds: [], components: [] });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Interlinear Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
