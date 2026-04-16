import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import { getBookId, bibleWrapper, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 3800;
const COLLECTOR_TIMEOUT_MS = 600_000;
const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;

function buildOriginalTextPage({
    bodyChunks, pageIdx, totalPages, bookId, bookName, chapter, verse,
    translation, englishVerseText, languageType, disableNav = false
}) {
    const accentColor = languageType === 'Hebrew' ? HEBREW_COLOR : GREEK_COLOR;
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📜 Original Text — ${bookName} ${chapter}:${verse}${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**${translation.toUpperCase()} Translation**\n${englishVerseText}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyChunks[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${languageType}${totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : ''}`
        ));

    const components = [container];

    // Chain buttons: jump to /bible or /interlinear for this verse
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:bible:${bookId}:${chapter}:${verse}`)
            .setLabel('Open passage')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${bookId}:${chapter}:${verse}`)
            .setLabel('Interlinear')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary)
    ));

    if (totalPages > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('page_back')
                .setEmoji({ name: '◀️' })
                .setLabel('Previous')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === 0),
            new ButtonBuilder()
                .setCustomId('page_next')
                .setEmoji({ name: '▶️' })
                .setLabel('Next')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(disableNav || pageIdx === totalPages - 1)
        ));
    }

    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('originaltext')
        .setDescription('View the original Hebrew/Greek text for a Bible verse')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
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
        const rawBookInput = interaction.options.getString('book').trim();
        const chapterInput = interaction.options.getString('chapter');
        const verseInput = interaction.options.getNumber('verse');
        const rawBook = swearWordFilter(rawBookInput);

        const chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Invalid chapter number provided.', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);
        if (!bookId || !bookName) {
            return interaction.reply({ content: `Invalid book: "${rawBook}".`, flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
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
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't fetch the English text for ${bookName} ${chapter}:${verseInput} (${translation}). ${reason}`
                    )]
                });
            }
            const englishVerseText = englishVerseResult.value[0][translation];

            if (originalTextResult.status === 'rejected') {
                logger.error(`[OriginalText Command] API request failed: ${originalTextResult.reason?.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't connect to the original text source.`
                    )]
                });
            }

            let wordData;
            try {
                const raw = originalTextResult.value?.data;
                wordData = typeof raw === 'string' ? JSON.parse(raw) : raw;
                if (!Array.isArray(wordData) || wordData.length === 0) {
                    throw new Error('Parsed data is not a non-empty array.');
                }
            } catch (parseError) {
                logger.error(`[OriginalText Command] Parse error: ${parseError.message}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Invalid data format from the original text source.`
                    )]
                });
            }

            const isNewTestament = bookId > 39;
            const languageType = isNewTestament ? 'Greek' : 'Hebrew';
            const languageEmoji = isNewTestament ? '🇬🇷' : '🕎';

            let combinedContent = `**${languageEmoji} ${languageType} Text**\n\`\`\`${wordData.map(w => w.word || '').join(' ')}\`\`\`\n`;

            let pronunciationSection = '';
            for (const word of wordData) {
                try {
                    if (word.pronun) {
                        const pronunData = JSON.parse(word.pronun);
                        pronunciationSection += `\`${word.word}\` — ${pronunData.dic_mod || pronunData.dic || 'N/A'}\n`;
                    }
                } catch (e) {
                    pronunciationSection += `\`${word.word}\` — (Error parsing pronunciation)\n`;
                }
            }
            if (pronunciationSection) {
                combinedContent += `\n**🗣️ Pronunciation Guide**\n${pronunciationSection}`;
            }

            let analysisSection = '';
            const strongsPrefix = isNewTestament ? 'G' : 'H';
            for (const word of wordData) {
                const morph = word.morph ? ` (\`${word.morph}\`)` : '';
                analysisSection += `\`${word.word}\` — ${strongsPrefix}${word.strongs || 'N/A'}${morph}\n`;
            }
            if (analysisSection) {
                combinedContent += `\n**📝 Word Analysis**\n${analysisSection}`;
            }

            let notesSection = '';
            for (const word of wordData) {
                if (word.notes) {
                    notesSection += `\`${word.word}\`: ${word.notes}\n`;
                }
            }
            if (notesSection) {
                combinedContent += `\n**📌 Notes**\n${notesSection}`;
            }

            const bodyChunks = splitString(combinedContent.trim(), MAX_CHARS_PER_PAGE);
            if (bodyChunks.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An error occurred while formatting the analysis.`)]
                });
            }

            const totalPages = bodyChunks.length;
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildOriginalTextPage({
                    bodyChunks, pageIdx, totalPages,
                    bookId, bookName, chapter, verse: verseInput,
                    translation, englishVerseText, languageType
                })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
                    else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
                    await i.editReply({
                        flags,
                        components: buildOriginalTextPage({
                            bodyChunks, pageIdx, totalPages,
                            bookId, bookName, chapter, verse: verseInput,
                            translation, englishVerseText, languageType
                        })
                    });
                } catch (err) {
                    logger.error(`[OriginalText Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildOriginalTextPage({
                            bodyChunks, pageIdx, totalPages,
                            bookId, bookName, chapter, verse: verseInput,
                            translation, englishVerseText, languageType,
                            disableNav: true
                        })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[OriginalText Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[OriginalText Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An unexpected error occurred.`)]
                });
            } catch (replyError) {
                logger.error(`[OriginalText Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
