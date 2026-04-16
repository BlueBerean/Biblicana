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
import { bibleWrapper, strongsWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const VERSE_FETCH_TIMEOUT_MS = 6000;
const STRONGS_FETCH_TIMEOUT_MS = 5000;
const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;
// Discord V2 caps total components in the tree at 40. Each word Section costs 3
// slots (Section + inner TextDisplay + Button accessory).
//  - No pagination: 2 (header) + 12 × 3 = 38.
//  - With pagination: 2 (header) + 11 × 3 + 3 (ActionRow + 2 buttons) = 38.
const WORDS_PER_PAGE_NO_NAV = 12;
const WORDS_PER_PAGE_WITH_NAV = 11;
const DEF_PREVIEW_LENGTH = 80;
const ORIGINAL_TEXT_SLICE = 600;
const PAGINATION_TIMEOUT_MS = 600_000;

const fetchTimeout = (ms, reason = 'Fetch timeout') =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));

function v2Error(message) {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [new TextDisplayBuilder().setContent(`❌ ${message}`)]
    };
}

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
        // Sync validation BEFORE defer — lets us reject with V1 ephemeral messages
        // without committing the deferred reply to the IsComponentsV2 flag.
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
            logger.warn(`[Interlinear Command] Invalid book: ${rawBook}`);
            return interaction.reply({
                content: `Invalid book: "${rawBook}". Use names like Genesis, John, 1 Corinthians, or abbreviations like gen, jn, 1co.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // From here on: commit to V2. All subsequent responses use Components V2.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[Interlinear Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            logger.info(`[Interlinear Command] Request: ${bookName} ${chapter}:${verseInput} (${translation})`);

            const [interlinearResult, englishResult] = await Promise.allSettled([
                Promise.race([bibleWrapper.getInterlinearVerse(bookId, chapter, verseInput), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'Interlinear fetch timeout')]),
                Promise.race([bibleWrapper.getVerses(bookId, chapter, verseInput, verseInput), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'English verse fetch timeout')])
            ]);

            if (interlinearResult.status === 'rejected' || !interlinearResult.value?.data) {
                const msg = interlinearResult.reason?.message || 'No data returned';
                logger.error(`[Interlinear Command] Failed to fetch interlinear data: ${msg}`);
                return interaction.editReply(v2Error(`Couldn't fetch interlinear data for ${bookName} ${chapter}:${verseInput}. (${msg})`));
            }
            if (englishResult.status === 'rejected' || !englishResult.value || englishResult.value.length === 0) {
                const msg = englishResult.reason?.message || 'Not found';
                logger.error(`[Interlinear Command] Failed to fetch English verse: ${msg}`);
                return interaction.editReply(v2Error(`Couldn't fetch English verse for ${bookName} ${chapter}:${verseInput}. (${msg})`));
            }

            let interlinearItems;
            try {
                interlinearItems = JSON.parse(interlinearResult.value.data);
                if (!Array.isArray(interlinearItems) || interlinearItems.length === 0) {
                    throw new Error('Parsed data is not a valid array or is empty.');
                }
            } catch (parseError) {
                logger.error(`[Interlinear Command] Error parsing interlinear JSON: ${parseError.message}`);
                return interaction.editReply(v2Error('Invalid interlinear data format from the source.'));
            }

            const englishVerseData = englishResult.value;
            const englishVerseText = englishVerseData[0]?.[translation] || `(${translation.toUpperCase()} translation not available)`;

            // Collect all words and their Strong's refs, then fetch Strong's data in parallel.
            const originalWords = [];
            const translitWords = [];
            const strongsRecords = [];
            let languageType = '';

            for (const item of interlinearItems) {
                if (!item || typeof item.number !== 'string' || !item.number) continue;

                originalWords.push(item.word || '');
                translitWords.push(item.text || '');

                const match = item.number.match(/([HG])(\d+)/i);
                if (!match) continue;

                const char = match[1].toUpperCase();
                const currentLexicon = char === 'G' ? 'Greek' : 'Hebrew';
                if (!languageType) languageType = currentLexicon;

                strongsRecords.push({
                    strongsId: `${char}${match[2]}`,
                    lexicon: currentLexicon,
                    word: item.word || ''
                });
            }

            const strongsDataMap = new Map();
            await Promise.allSettled(strongsRecords.map(async (rec) => {
                if (strongsDataMap.has(rec.strongsId)) return;
                try {
                    const data = await Promise.race([
                        strongsWrapper.getStrongsId(rec.lexicon, rec.strongsId),
                        fetchTimeout(STRONGS_FETCH_TIMEOUT_MS, `Strongs ${rec.strongsId} timeout`)
                    ]);
                    strongsDataMap.set(rec.strongsId, data || null);
                } catch (e) {
                    logger.warn(`[Interlinear Command] Strongs fetch failed for ${rec.strongsId}: ${e.message}`);
                    strongsDataMap.set(rec.strongsId, null);
                }
            }));

            const originalText = originalWords.join(' ').trim().substring(0, ORIGINAL_TEXT_SLICE);
            const translitText = translitWords.join(' ').trim().substring(0, ORIGINAL_TEXT_SLICE);
            const translitDirection = languageType === 'Hebrew' ? '(Right to Left)' : '(Left to Right)';
            const accentColor = languageType === 'Greek' ? GREEK_COLOR : HEBREW_COLOR;

            const needsPagination = strongsRecords.length > WORDS_PER_PAGE_NO_NAV;
            const wordsPerPage = needsPagination ? WORDS_PER_PAGE_WITH_NAV : WORDS_PER_PAGE_NO_NAV;
            const totalPages = needsPagination
                ? Math.ceil(strongsRecords.length / wordsPerPage)
                : 1;
            let currentPage = 0;

            const buildPageComponents = (pageIdx, { disableNav = false } = {}) => {
                const start = pageIdx * wordsPerPage;
                const end = Math.min(start + wordsPerPage, strongsRecords.length);
                const pageRecords = strongsRecords.slice(start, end);

                const pageInfo = totalPages > 1 ? ` (Page ${pageIdx + 1}/${totalPages})` : '';
                const headerText = [
                    `## 📖 Interlinear — ${bookName} ${chapter}:${verseInput}`,
                    '',
                    `**${translation.toUpperCase()} Translation**`,
                    englishVerseText,
                    '',
                    `**📜 Original ${languageType || 'Text'}** ${translitDirection}`,
                    `\`\`\`${originalText || '(no data)'}\`\`\``,
                    `**🔄 Transliteration**`,
                    `\`\`\`${translitText || '(no data)'}\`\`\``,
                    '',
                    `### 📚 Strong's Words${pageInfo}`,
                    `*Tap any word to view its full definition.*`
                ].join('\n');

                const header = new ContainerBuilder()
                    .setAccentColor(accentColor)
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));

                const pageComponents = [header];

                if (strongsRecords.length === 0) {
                    pageComponents.push(new TextDisplayBuilder().setContent('*No Strong\'s tagging available for this verse.*'));
                    return pageComponents;
                }

                for (const [localIdx, rec] of pageRecords.entries()) {
                    const globalIdx = start + localIdx;
                    const data = strongsDataMap.get(rec.strongsId);
                    const translit = data
                        ? (rec.lexicon === 'Greek' ? (data.translit || data.xlit) : (data.xlit || data.translit))
                        : null;
                    const rawDef = data?.strong_def || data?.definition || 'Definition unavailable.';
                    const preview = rawDef.length > DEF_PREVIEW_LENGTH
                        ? rawDef.substring(0, DEF_PREVIEW_LENGTH - 1) + '…'
                        : rawDef;

                    const headline = `**${rec.strongsId}** — \`${rec.word || '—'}\`${translit ? ` *(${translit})*` : ''}`;
                    const body = `${headline}\n> ${preview}`;

                    // Global index (:globalIdx) keeps custom_ids unique across pages
                    // when a verse repeats the same Strong's word. Handler ignores it.
                    const section = new SectionBuilder()
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
                        .setButtonAccessory(
                            new ButtonBuilder()
                                .setCustomId(`strongs:${rec.lexicon}:${rec.strongsId}:${globalIdx}`)
                                .setLabel('Define')
                                .setEmoji({ name: '📖' })
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(!data)
                        );

                    pageComponents.push(section);
                }

                if (totalPages > 1) {
                    const row = new ActionRowBuilder().addComponents(
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
                    );
                    pageComponents.push(row);
                }

                return pageComponents;
            };

            logger.info(`[Interlinear Command] Rendering V2 response for ${bookName} ${chapter}:${verseInput} — ${strongsRecords.length} Strong's entries across ${totalPages} page(s).`);

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPageComponents(currentPage)
            });

            if (totalPages <= 1) return;

            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_next' || i.customId === 'page_back');
            const collector = message.createMessageComponentCollector({ filter, time: PAGINATION_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                    else if (i.customId === 'page_back') currentPage = Math.max(0, currentPage - 1);
                    await i.editReply({
                        flags: MessageFlags.IsComponentsV2,
                        components: buildPageComponents(currentPage)
                    });
                } catch (collectError) {
                    logger.error(`[Interlinear Command] Pagination error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                logger.info(`[Interlinear Command] Pagination collector ended for ${bookName} ${chapter}:${verseInput}`);
                message.edit({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildPageComponents(currentPage, { disableNav: true })
                }).catch(e => {
                    if (e.code !== 10008) logger.error(`[Interlinear Command] Error disabling pagination: ${e}`);
                });
            });
        } catch (error) {
            logger.error(`[Interlinear Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply(v2Error('An unexpected error occurred. Please try again later.'));
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Interlinear Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
