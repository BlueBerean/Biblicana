import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { getBookId, bibleWrapper, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import { fetchIQBible } from '../utils/rapidApi.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import 'dotenv/config';

// Discord's 40-component tree cap: 2 (header) + 10*3 (word Sections) + 3
// (action row) + 3 (pagination row) = 38. Ten words/page works for every
// Greek verse and paginates long Hebrew ones across a few pages.
const WORDS_PER_PAGE_NO_NAV = 11;
const WORDS_PER_PAGE_WITH_NAV = 10;
const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;
const MAX_SECTION_TEXT = 280;

function parsePronunciation(pronunField) {
    if (!pronunField) return null;
    try {
        const data = JSON.parse(pronunField);
        return data.dic_mod || data.dic || null;
    } catch (e) {
        return null;
    }
}

// Normalize a word row from RapidAPI into the shape we render per-Section.
function processWord(word, strongsPrefix) {
    const strongsRaw = word.strongs;
    const strongsId = strongsRaw ? `${strongsPrefix}${strongsRaw}` : null;
    const lexicon = strongsPrefix === 'G' ? 'Greek' : 'Hebrew';
    return {
        original: word.word || '',
        pronunciation: parsePronunciation(word.pronun),
        morph: word.morph || null,
        strongsId,
        lexicon,
        notes: word.notes || null
    };
}

function buildWordSectionText(wordInfo) {
    const lines = [];
    const titleBits = [`**${wordInfo.original}**`];
    if (wordInfo.pronunciation) titleBits.push(`*${wordInfo.pronunciation}*`);
    lines.push(titleBits.join(' — '));

    if (wordInfo.strongsId) {
        const morphTag = wordInfo.morph ? ` *(${wordInfo.morph})*` : '';
        lines.push(`${wordInfo.strongsId}${morphTag}`);
    }
    if (wordInfo.notes) {
        const note = wordInfo.notes.length > 120
            ? wordInfo.notes.substring(0, 119) + '…'
            : wordInfo.notes;
        lines.push(`📌 *${note}*`);
    }

    let joined = lines.join('\n');
    if (joined.length > MAX_SECTION_TEXT) joined = joined.substring(0, MAX_SECTION_TEXT - 1) + '…';
    return joined;
}

function buildOriginalTextPage({
    words, pageIdx, wordsPerPage, totalPages, bookId, bookName, chapter, verse,
    translation, englishVerseText, originalJoined, languageType,
    disableNav = false
}) {
    const accentColor = languageType === 'Hebrew' ? HEBREW_COLOR : GREEK_COLOR;
    const start = pageIdx * wordsPerPage;
    const end = Math.min(start + wordsPerPage, words.length);
    const pageWords = words.slice(start, end);
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const headerLines = [
        `## 📜 Original Text — ${bookName} ${chapter}:${verse}`,
        '',
        `**${translation.toUpperCase()} Translation**`,
        englishVerseText,
        '',
        `**${languageType === 'Hebrew' ? '🕎' : '🇬🇷'} ${languageType} Text** ${languageType === 'Hebrew' ? '(Right to Left)' : '(Left to Right)'}`,
        `\`\`\`${originalJoined}\`\`\``,
        '',
        `### Words${pageInfo}`,
        `*Tap any word for its full definition.*`
    ];

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));

    for (const [localIdx, wordInfo] of pageWords.entries()) {
        const globalIdx = start + localIdx;
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildWordSectionText(wordInfo)));

        if (wordInfo.strongsId) {
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`strongs:${wordInfo.lexicon}:${wordInfo.strongsId}:${globalIdx}`)
                    .setLabel('Define')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            // No Strong's — button is disabled. Sections require an accessory
            // even in this case, so we keep the button shape but make it inert.
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`strongs:none:none:${globalIdx}`)
                    .setLabel('Define')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        }

        container.addSectionComponents(section);
    }

    const components = [container];

    // Action row — cross-command navigation.
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
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
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

            const [originalTextResult, englishVerseResult] = await Promise.allSettled([
                fetchIQBible('GetOriginalText', { verseId }),
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
            const strongsPrefix = isNewTestament ? 'G' : 'H';
            const words = wordData.map(w => processWord(w, strongsPrefix));
            const originalJoined = wordData.map(w => w.word || '').join(' ').trim().substring(0, 600);

            const needsPagination = words.length > WORDS_PER_PAGE_NO_NAV;
            const wordsPerPage = needsPagination ? WORDS_PER_PAGE_WITH_NAV : WORDS_PER_PAGE_NO_NAV;
            const totalPages = needsPagination ? Math.ceil(words.length / wordsPerPage) : 1;

            logger.info(`[OriginalText Command] ${words.length} words across ${totalPages} page(s).`);

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildOriginalTextPage({
                    words, pageIdx: 0, wordsPerPage, totalPages,
                    bookId, bookName, chapter, verse: verseInput,
                    translation, englishVerseText, originalJoined, languageType
                })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[OriginalText Command]',
                render: (pageIdx, { disableNav }) =>
                    buildOriginalTextPage({
                        words, pageIdx, wordsPerPage, totalPages,
                        bookId, bookName, chapter, verse: verseInput,
                        translation, englishVerseText, originalJoined, languageType, disableNav
                    })
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
