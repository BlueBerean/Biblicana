import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { bibleWrapper, numbersToBook } from './bibleHelper.js';
import { accentColor, footerLine } from './theme.js';

/**
 * Fetches a single random verse row (optionally filtered by book/chapter) and
 * picks the best translation for display. Preference: user's chosen translation
 * (from /setversion), then BSB, then the first non-empty column.
 *
 * Returns null if no verse matches the filter.
 */
export async function fetchRandomVerseData({ filterBookId = null, filterChapter = null, preferredTranslation = 'BSB' } = {}) {
    const row = await bibleWrapper.getRandomVerse(filterBookId, filterChapter);
    if (!row) return null;

    // sqlite returns these as strings from the column; normalize to numbers
    // so they key correctly into numbersToBook and serialize cleanly into customIds.
    const bookId = parseInt(row.bookID);
    const chapter = parseInt(row.chapter);
    const verse = parseInt(row.verse);

    const bookName = numbersToBook.get(bookId);
    if (!bookName) return null;

    // Choose translation column: preferred, then BSB, then first non-empty.
    // Fallback list intentionally excludes NASB, NKJV, AMPC — those columns
    // exist in bible.db but we lack the commercial license to surface them.
    const candidates = [preferredTranslation, 'BSB', 'KJV', 'ASV', 'AKJV'];
    let translation = null;
    let text = null;
    for (const col of candidates) {
        if (row[col] && row[col].trim()) {
            translation = col;
            text = row[col].trim();
            break;
        }
    }
    if (!text) return null;

    return {
        bookId,
        bookName,
        chapter,
        verse,
        text,
        translation
    };
}

/**
 * Builds the V2 component array for a random-verse response, including the
 * 4-button openverse action row and a [🎲 Another] button that refreshes.
 *
 * `filterBookId` / `filterChapter` are encoded into the [Another] customId
 * so the refresh respects the original command's book/chapter filters.
 * Pass 0 (or null) for "no filter".
 */
export function buildRandomVerseComponents({ data, filterBookId = 0, filterChapter = 0 }) {
    const scopeHint = filterBookId && filterChapter
        ? ` (filtered to ${numbersToBook.get(filterBookId)} ${filterChapter})`
        : filterBookId
            ? ` (filtered to ${numbersToBook.get(filterBookId)})`
            : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 🎲 Random Verse — ${data.bookName} ${data.chapter}:${data.verse}${scopeHint}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${data.verse}** ${data.text}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`Translation: ${data.translation.toUpperCase()}`)
        ));

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${data.bookId}:${data.chapter}:${data.verse}`)
            .setLabel('Interlinear')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${data.bookId}:${data.chapter}:${data.verse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${data.bookId}:${data.chapter}:${data.verse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${data.bookId}:${data.chapter}:${data.verse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`randomverse:${filterBookId || 0}:${filterChapter || 0}`)
            .setLabel('Another')
            .setEmoji({ name: '🎲' })
            .setStyle(ButtonStyle.Primary)
    );

    return [container, actionRow];
}
