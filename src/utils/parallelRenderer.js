import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} from 'discord.js';
import { bibleWrapper, numbersToBook } from './bibleHelper.js';
import { accentColor, footerLine } from './theme.js';
import logger from './logger.js';

const MAX_CHARS_PER_PAGE = 3800;
export const PARALLEL_PAGINATION_TIMEOUT_MS = 600_000;

// Columns in bible.db `english` table carrying translation text we are
// licensed to surface. NASB, NKJV, and AMPC exist in the DB but are
// intentionally omitted here — we lack commercial redistribution rights,
// so those columns must not appear in /parallel output.
export const PARALLEL_TRANSLATION_COLUMNS = [
    'BSB', 'KJV', 'ASV', 'AKJV',
    'CPDV', 'DBT', 'DRB', 'ERV', 'JPSWEY',
    'NHEB', 'SLT', 'WBT', 'WEB', 'YLT'
];

function displayLabel(col) {
    return col === 'JPSWEY' ? 'JPS/WEY' : col;
}

/**
 * Fetches all 16 translations for a single verse from local bible.db.
 * If `primaryTranslation` is provided, that translation is listed first.
 *
 * Returns null when the verse doesn't exist.
 */
export async function fetchParallelData({ bookId, chapter, verse, primaryTranslation = null }) {
    const rows = await bibleWrapper.getVerses(bookId, chapter, verse, verse);
    if (!rows || rows.length === 0) return null;

    const row = rows[0];
    const bookName = numbersToBook.get(bookId);
    const orderedColumns = primaryTranslation
        ? [primaryTranslation, ...PARALLEL_TRANSLATION_COLUMNS.filter(c => c !== primaryTranslation)]
        : PARALLEL_TRANSLATION_COLUMNS;

    const lines = [];
    for (const col of orderedColumns) {
        const text = row[col];
        if (text && typeof text === 'string' && text.trim()) {
            lines.push(`**${displayLabel(col)}**: ${text.trim()}`);
        }
    }

    return { bookName, chapter, verse, lines };
}

/**
 * Adaptive page-packing: group translation lines into pages that fit under
 * Discord's per-TextDisplay character budget. Short verses collapse to one page;
 * long ones (Esther 8:9) spread across several.
 */
export function packParallelPages(lines) {
    const pages = [];
    let current = [];
    let len = 0;
    for (const line of lines) {
        const added = line.length + (current.length > 0 ? 2 : 0); // +2 for "\n\n"
        if (len + added > MAX_CHARS_PER_PAGE && current.length > 0) {
            pages.push(current);
            current = [line];
            len = line.length;
        } else {
            current.push(line);
            len += added;
        }
    }
    if (current.length > 0) pages.push(current);
    return pages;
}

/**
 * Builds the V2 component array for a single parallel page.
 */
export function buildParallelPage({ data, pages, pageIdx = 0, includePaginationRow = true, disableNav = false }) {
    const totalPages = pages.length;
    const pageInfo = totalPages > 1 ? ` (Page ${pageIdx + 1}/${totalPages})` : '';
    const footerSuffix = totalPages > 1
        ? `${data.lines.length} translations | Page ${pageIdx + 1}/${totalPages}`
        : `${data.lines.length} translations`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📑 Parallel Translations — ${data.bookName} ${data.chapter}:${data.verse}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(pages[pageIdx].join('\n\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine(footerSuffix)));

    const components = [container];

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
 * Attaches a pagination collector to an already-sent parallel message.
 * Shared by /parallel slash (non-ephemeral) and the [Parallel] button (ephemeral).
 */
export async function setupParallelPagination({ interaction, data, pages, flags, timeoutMs = PARALLEL_PAGINATION_TIMEOUT_MS }) {
    if (pages.length <= 1) return;

    try {
        const message = await interaction.fetchReply();
        let currentPageIdx = 0;

        const filter = i => i.user.id === interaction.user.id &&
            (i.customId === 'page_back' || i.customId === 'page_next');
        const collector = message.createMessageComponentCollector({ filter, time: timeoutMs });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                if (i.customId === 'page_next') currentPageIdx = Math.min(pages.length - 1, currentPageIdx + 1);
                else currentPageIdx = Math.max(0, currentPageIdx - 1);
                await i.editReply({
                    flags,
                    components: buildParallelPage({ data, pages, pageIdx: currentPageIdx })
                });
            } catch (err) {
                logger.error(`[Parallel Pagination] Collect error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({
                    flags,
                    components: buildParallelPage({ data, pages, pageIdx: currentPageIdx, disableNav: true })
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    logger.error(`[Parallel Pagination] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        logger.error(`[Parallel Pagination] Setup error: ${err.message}`);
    }
}

/**
 * One-call ephemeral reply + pagination, used by the [Parallel] button.
 */
export async function renderParallelEphemeral({ interaction, bookId, chapter, verse, primaryTranslation = null }) {
    const data = await fetchParallelData({ bookId, chapter, verse, primaryTranslation });
    if (!data || data.lines.length === 0) {
        await interaction.reply({
            content: `No translations found for this verse.`,
            flags: MessageFlags.Ephemeral
        });
        return;
    }

    const pages = packParallelPages(data.lines);
    const flags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

    await interaction.reply({
        flags,
        components: buildParallelPage({ data, pages, pageIdx: 0 })
    });

    await setupParallelPagination({ interaction, data, pages, flags });
}
