import {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} from 'discord.js';
import { bibleWrapper, strongsWrapper, numbersToBook } from './bibleHelper.js';
import logger from './logger.js';

const VERSE_FETCH_TIMEOUT_MS = 6000;
const STRONGS_FETCH_TIMEOUT_MS = 5000;
const HEBREW_COLOR = 0x3498DB;
const GREEK_COLOR = 0x9B59B6;
const DEF_PREVIEW_LENGTH = 80;
const ORIGINAL_TEXT_SLICE = 600;

export const WORDS_PER_PAGE_NO_NAV = 12;
export const WORDS_PER_PAGE_WITH_NAV = 11;
export const INTERLINEAR_PAGINATION_TIMEOUT_MS = 600_000;

const fetchTimeout = (ms, reason = 'Fetch timeout') =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(reason)), ms));

/**
 * Fetches and processes all data needed to render an interlinear view of one verse.
 * Returns a single data object consumable by buildInterlinearPage().
 *
 * Throws on unrecoverable fetch/parse failure. Strong's-word-level fetch failures
 * are tolerated — the resulting record has `data: null` and the UI disables that button.
 */
export async function fetchInterlinearData({ bookId, chapter, verse, translation }) {
    const bookName = numbersToBook.get(bookId);

    const [interlinearResult, englishResult] = await Promise.allSettled([
        Promise.race([bibleWrapper.getInterlinearVerse(bookId, chapter, verse), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'Interlinear fetch timeout')]),
        Promise.race([bibleWrapper.getVerses(bookId, chapter, verse, verse), fetchTimeout(VERSE_FETCH_TIMEOUT_MS, 'English verse fetch timeout')])
    ]);

    if (interlinearResult.status === 'rejected' || !interlinearResult.value?.data) {
        throw new Error(`Couldn't fetch interlinear data: ${interlinearResult.reason?.message || 'No data returned'}`);
    }
    if (englishResult.status === 'rejected' || !englishResult.value || englishResult.value.length === 0) {
        throw new Error(`Couldn't fetch English verse: ${englishResult.reason?.message || 'Not found'}`);
    }

    let interlinearItems;
    try {
        interlinearItems = JSON.parse(interlinearResult.value.data);
        if (!Array.isArray(interlinearItems) || interlinearItems.length === 0) {
            throw new Error('Parsed data is not a valid array or is empty.');
        }
    } catch (parseError) {
        throw new Error(`Invalid interlinear data format: ${parseError.message}`);
    }

    const englishVerseData = englishResult.value;
    const englishVerseText = englishVerseData[0]?.[translation] || `(${translation.toUpperCase()} translation not available)`;

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
            logger.warn(`[Interlinear Renderer] Strongs fetch failed for ${rec.strongsId}: ${e.message}`);
            strongsDataMap.set(rec.strongsId, null);
        }
    }));

    const originalText = originalWords.join(' ').trim().substring(0, ORIGINAL_TEXT_SLICE);
    const translitText = translitWords.join(' ').trim().substring(0, ORIGINAL_TEXT_SLICE);
    const translitDirection = languageType === 'Hebrew' ? '(Right to Left)' : '(Left to Right)';
    const accentColor = languageType === 'Greek' ? GREEK_COLOR : HEBREW_COLOR;

    return {
        bookName,
        chapter,
        verse,
        translation,
        strongsRecords,
        strongsDataMap,
        originalText,
        translitText,
        englishVerseText,
        languageType,
        accentColor,
        translitDirection
    };
}

/**
 * Computes pagination metadata from the total number of tagged Strong's words.
 * Verses ≤12 words render on a single page without a nav row.
 */
export function computeInterlinearPagination(strongsRecordsLength) {
    const needsPagination = strongsRecordsLength > WORDS_PER_PAGE_NO_NAV;
    const wordsPerPage = needsPagination ? WORDS_PER_PAGE_WITH_NAV : WORDS_PER_PAGE_NO_NAV;
    const totalPages = needsPagination
        ? Math.ceil(strongsRecordsLength / wordsPerPage)
        : 1;
    return { needsPagination, wordsPerPage, totalPages };
}

/**
 * Builds the V2 component array for a single interlinear page.
 *
 * @param data — output of fetchInterlinearData()
 * @param pageIdx — zero-based page index
 * @param wordsPerPage — from computeInterlinearPagination
 * @param totalPages — from computeInterlinearPagination
 * @param includePaginationRow — when false, no [◀][▶] row. Useful for ephemeral
 *   button-reply previews that don't support collector state.
 * @param disableNav — when true, pagination buttons are rendered as disabled
 *   (used when a collector times out)
 * @param footerHint — optional extra text appended to the header, e.g.,
 *   "For all pages, use /interlinear book:... chapter:... verse:..."
 */
export function buildInterlinearPage({
    data,
    pageIdx = 0,
    wordsPerPage,
    totalPages,
    includePaginationRow = true,
    disableNav = false,
    footerHint = null
}) {
    const start = pageIdx * wordsPerPage;
    const end = Math.min(start + wordsPerPage, data.strongsRecords.length);
    const pageRecords = data.strongsRecords.slice(start, end);

    const pageInfo = totalPages > 1 ? ` (Page ${pageIdx + 1}/${totalPages})` : '';
    const headerLines = [
        `## 📖 Interlinear — ${data.bookName} ${data.chapter}:${data.verse}`,
        '',
        `**${data.translation.toUpperCase()} Translation**`,
        data.englishVerseText,
        '',
        `**📜 Original ${data.languageType || 'Text'}** ${data.translitDirection}`,
        `\`\`\`${data.originalText || '(no data)'}\`\`\``,
        `**🔄 Transliteration**`,
        `\`\`\`${data.translitText || '(no data)'}\`\`\``,
        '',
        `### 📚 Strong's Words${pageInfo}`,
        `*Tap any word to view its full definition.*`
    ];
    if (footerHint) {
        headerLines.push('', footerHint);
    }

    const header = new ContainerBuilder()
        .setAccentColor(data.accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));

    const components = [header];

    if (data.strongsRecords.length === 0) {
        components.push(new TextDisplayBuilder().setContent('*No Strong\'s tagging available for this verse.*'));
        return components;
    }

    for (const [localIdx, rec] of pageRecords.entries()) {
        const globalIdx = start + localIdx;
        const entry = data.strongsDataMap.get(rec.strongsId);
        const translit = entry
            ? (rec.lexicon === 'Greek' ? (entry.translit || entry.xlit) : (entry.xlit || entry.translit))
            : null;
        const rawDef = entry?.strong_def || entry?.definition || 'Definition unavailable.';
        const preview = rawDef.length > DEF_PREVIEW_LENGTH
            ? rawDef.substring(0, DEF_PREVIEW_LENGTH - 1) + '…'
            : rawDef;

        const headline = `**${rec.strongsId}** — \`${rec.word || '—'}\`${translit ? ` *(${translit})*` : ''}`;
        const body = `${headline}\n> ${preview}`;

        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`strongs:${rec.lexicon}:${rec.strongsId}:${globalIdx}`)
                    .setLabel('Define')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!entry)
            );

        components.push(section);
    }

    if (includePaginationRow && totalPages > 1) {
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
        components.push(row);
    }

    return components;
}

/**
 * Attaches a pagination collector to an already-sent interlinear message.
 * Works for both non-ephemeral (slash command) and ephemeral (button) flows.
 *
 * - `interaction` must be the interaction that produced the message
 *   (either a ChatInputCommandInteraction that called deferReply+editReply,
 *    or a ButtonInteraction that called reply).
 * - `flags` should be the same flags used on the initial message so that
 *   the edit-on-end keeps MessageFlags.IsComponentsV2 set.
 *
 * No-op when totalPages <= 1.
 */
export async function setupInterlinearPagination({
    interaction,
    data,
    totalPages,
    wordsPerPage,
    flags,
    timeoutMs = INTERLINEAR_PAGINATION_TIMEOUT_MS
}) {
    if (totalPages <= 1) return;

    try {
        const message = await interaction.fetchReply();
        let currentPage = 0;

        const filter = i => i.user.id === interaction.user.id &&
            (i.customId === 'page_next' || i.customId === 'page_back');
        const collector = message.createMessageComponentCollector({ filter, time: timeoutMs });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                else if (i.customId === 'page_back') currentPage = Math.max(0, currentPage - 1);
                await i.editReply({
                    flags,
                    components: buildInterlinearPage({ data, pageIdx: currentPage, wordsPerPage, totalPages })
                });
            } catch (err) {
                logger.error(`[Interlinear Pagination] Collect error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({
                    flags,
                    components: buildInterlinearPage({ data, pageIdx: currentPage, wordsPerPage, totalPages, disableNav: true })
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    logger.error(`[Interlinear Pagination] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        logger.error(`[Interlinear Pagination] Setup error: ${err.message}`);
    }
}

/**
 * Convenience: reply ephemerally with a paginated interlinear view.
 * Used by the [Interlinear] button on /bible.
 */
export async function renderInterlinearEphemeral({ interaction, bookId, chapter, verse, translation }) {
    const data = await fetchInterlinearData({ bookId, chapter, verse, translation });
    const { wordsPerPage, totalPages } = computeInterlinearPagination(data.strongsRecords.length);

    const flags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

    await interaction.reply({
        flags,
        components: buildInterlinearPage({ data, pageIdx: 0, wordsPerPage, totalPages })
    });

    await setupInterlinearPagination({ interaction, data, totalPages, wordsPerPage, flags });
}
