import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import axios from 'axios';
import { getBookId, bibleWrapper, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 4000;
const COLLECTOR_TIMEOUT_MS = 600_000;

function generateFooter(translation = "BSB", page, maxPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`,
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
        .setName('originaltext')
        .setDescription('View the original Hebrew/Greek text for a Bible verse')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want to see the original text for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter you want to see the original text for')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse you want to see the original text for')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show in parallel')
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
                logger.warn(`[OriginalText Command] Invalid book: ${rawBook}`);
                return interaction.editReply({ content: `Invalid book: "${rawBook}".`, ephemeral: true });
            }

            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[OriginalText Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verseInput.toString().padStart(3, '0')}`;
            logger.info(`[OriginalText Command] Request: ${bookName} ${chapter}:${verseInput} (ID: ${verseId}, Translation: ${translation})`);

            const apiOptions = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetOriginalText',
                params: { verseId },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const [originalTextResult, englishVerseResult] = await Promise.allSettled([
                axios.request(apiOptions),
                bibleWrapper.getVerses(bookId, chapter, verseInput, verseInput)
            ]);

            if (englishVerseResult.status === 'rejected' || !englishVerseResult.value || englishVerseResult.value.length === 0 || !englishVerseResult.value[0][translation]) {
                const reason = englishVerseResult.reason?.message || 'Not Found or Translation Unavailable';
                logger.error(`[OriginalText Command] Failed to fetch English verse ${bookName} ${chapter}:${verseInput} (${translation}): ${reason}`);
                return interaction.editReply({ content: `Sorry, I couldn't fetch the English text for ${bookName} ${chapter}:${verseInput} (${translation}). ${reason}`, ephemeral: true });
            }
            const englishVerseText = englishVerseResult.value[0][translation];

            if (originalTextResult.status === 'rejected') {
                logger.error(`[OriginalText Command] API request failed for verse ID ${verseId}: ${originalTextResult.reason?.message}`);
                if (originalTextResult.reason?.response) {
                    logger.error(`[OriginalText Command] API Error Status: ${originalTextResult.reason.response.status}`);
                    logger.error(`[OriginalText Command] API Error Data: ${JSON.stringify(originalTextResult.reason.response.data)}`);
                }
                return interaction.editReply({ content: 'Sorry, failed to connect to the original text source.', ephemeral: true });
            }

            let wordDataRaw = originalTextResult.value?.data;
            let wordData;
            try {
                if (typeof wordDataRaw === 'string') {
                    logger.debug("[OriginalText Command] API response was a string, attempting JSON parse.");
                    wordData = JSON.parse(wordDataRaw);
                } else {
                    wordData = wordDataRaw;
                }
                if (!Array.isArray(wordData) || wordData.length === 0) {
                    throw new Error('Parsed data is not a non-empty array.');
                }
            } catch (parseError) {
                logger.error(`[OriginalText Command] Failed to parse original text data for ${verseId}: ${parseError.message}`);
                logger.debug("[OriginalText Command] Raw original text response data:", wordDataRaw);
                return interaction.editReply({ content: 'Sorry, received invalid data format from the original text source.', ephemeral: true });
            }

            const isNewTestament = bookId > 39;
            const languageName = isNewTestament ? 'Greek' : 'Hebrew';
            const languageEmoji = isNewTestament ? '🇬🇷' : '🕎';

            let combinedContent = `**${bookName} ${chapter}:${verseInput} (${translation.toUpperCase()})**\n${englishVerseText}\n\n`;
            combinedContent += `**${languageEmoji} ${languageName}:**\n${wordData.map(w => w.word || '').join(' ')}\n\n`;

            let pronunciationSection = "";
            for (const word of wordData) {
                try {
                    if (word.pronun) {
                        const pronunData = JSON.parse(word.pronun);
                        pronunciationSection += `\`${word.word}\` - ${pronunData.dic_mod || pronunData.dic || 'N/A'}\n`;
                    }
                } catch (e) {
                    logger.warn(`[OriginalText Command] Error parsing pronunciation for "${word.word}" (${verseId}): ${e.message}`);
                    pronunciationSection += `\`${word.word}\` - (Error parsing pronunciation)\n`;
                }
            }
            if (pronunciationSection) {
                combinedContent += `**🗣️ Pronunciation Guide:**\n${pronunciationSection}\n`;
            }

            let analysisSection = "";
            const strongsPrefix = isNewTestament ? 'G' : 'H';
            for (const word of wordData) {
                const morph = word.morph ? `(\`${word.morph}\`)` : '';
                analysisSection += `\`${word.word}\` - ${strongsPrefix}${word.strongs || 'N/A'} ${morph}\n`;
            }
            if (analysisSection) {
                combinedContent += `**📝 Word Analysis:**\n${analysisSection}\n`;
            }

            let notesSection = "";
            for (const word of wordData) {
                if (word.notes) {
                    notesSection += `\`${word.word}\`: ${word.notes}\n`;
                }
            }
            if (notesSection) {
                combinedContent += `**📌 Notes:**\n${notesSection}\n`;
            }

            combinedContent += `\n*For detailed Strong's definitions, use the /interlinear command.*`;

            const pages = splitString(combinedContent, MAX_CHARS_PER_PAGE);

            if (pages.length === 0) {
                logger.error("[OriginalText Command] Failed to create pages from combined content.");
                return interaction.editReply({ content: 'Sorry, an error occurred while formatting the analysis.', ephemeral: true });
            }

            let currentPageIndex = 0;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📜 Original Text Analysis - ${bookName} ${chapter}:${verseInput}`)
                .setDescription(pages[currentPageIndex])
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, currentPageIndex, pages.length));

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
                        .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                } catch (collectError) {
                    logger.error(`[OriginalText Command] Error updating pagination: ${collectError}`);
                    try { await i.followUp({ content: 'Error changing page.', ephemeral: true }); } catch (followUpError) {
                        logger.warn(`[OriginalText Command] Failed to send follow-up pagination error: ${followUpError.message}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[OriginalText Command] Pagination collector ended for ${bookName} ${chapter}:${verseInput}`);
                const timedOutRow = createActionRow(currentPageIndex, pages.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    if (editError.code !== 10008) {
                        logger.error(`[OriginalText Command] Error disabling buttons: ${editError}`);
                    }
                });
            });
        } catch (error) {
            logger.error(`[OriginalText Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({ content: 'An unexpected error occurred. Please try again later.', embeds: [], components: [] });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[OriginalText Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
