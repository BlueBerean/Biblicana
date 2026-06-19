import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { createRequire } from 'node:module';
import { bibleWrapper } from './bibleHelper.js';
import { numbersToBook, getBookId } from './bookNames.js';
import { accentColor, footerLine } from './theme.js';
import logger from './logger.js';

const require = createRequire(import.meta.url);
const VOTDData = require('../../data/VOTD.json');

const MAX_BODY_CHARS = 3800;
const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Look up today's VOTD reference string from the calendar.
 * @param {Date} [date] — defaults to `new Date()`; pass a specific date for testing/scheduling
 * @returns {string|null} — e.g., "John 3:16" or null if no calendar entry
 */
export function getVOTDReferenceFor(date = new Date()) {
    const monthName = MONTH_NAMES[date.getMonth()];
    const dayOfMonth = date.getDate().toString();
    return VOTDData?.[monthName]?.[dayOfMonth] ?? null;
}

/**
 * Parse a VOTD-style reference string ("John 3:16" / "Romans 8:28-30") into
 * structured fields. Returns null on any parse or book-lookup failure.
 */
export function parseVOTDReference(refString) {
    if (!refString) return null;
    const match = refString.match(/^([1-3]?\s*[\w\s]+?)\s+(\d+):(\d+)(?:-(\d+))?$/i);
    if (!match) return null;
    const bookId = getBookId(match[1].trim());
    if (!bookId) return null;
    const chapter = parseInt(match[2]);
    const startVerse = parseInt(match[3]);
    const endVerse = match[4] ? parseInt(match[4]) : startVerse;
    if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) return null;
    return { bookId, chapter, startVerse, endVerse };
}

/**
 * Build the V2 component tree for a daily passage response. Used by both
 * /passageoftheday (user-invoked) and the daily verse scheduler (auto-posted).
 * Renders identical chrome in both paths so users see a consistent surface.
 */
export function buildDailyVerseComponents({ bookId, bookName, chapter, startVerse, endVerse, body, translation, dateString }) {
    const rangeLabel = endVerse > startVerse
        ? `${bookName} ${chapter}:${startVerse}-${endVerse}`
        : `${bookName} ${chapter}:${startVerse}`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📅 Verse of the Day — ${dateString}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${rangeLabel}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`Translation: ${translation.toUpperCase()}`)
        ));

    const openCustomId = endVerse > startVerse
        ? `openverse:bible:${bookId}:${chapter}:${startVerse}:${endVerse}`
        : `openverse:bible:${bookId}:${chapter}:${startVerse}`;

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(openCustomId)
            .setLabel('Open')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary)
    );

    return [container, actionRow];
}

/**
 * Fetch + build the full components array for today's (or any given date's)
 * verse in a specific translation. Returns null if lookup fails at any step.
 *
 * Used by both /passageoftheday (pass the user's translation) and the
 * scheduler (pass guild-default / BSB).
 */
export async function renderVerseOfTheDay({ date = new Date(), translation = 'BSB' } = {}) {
    const referenceString = getVOTDReferenceFor(date);
    if (!referenceString) {
        logger.warn(`[DailyVerse] No calendar entry for ${date.toISOString().slice(0, 10)}`);
        return null;
    }

    const parsed = parseVOTDReference(referenceString);
    if (!parsed) {
        logger.error(`[DailyVerse] Failed to parse "${referenceString}"`);
        return null;
    }

    const { bookId, chapter, startVerse, endVerse } = parsed;
    const bookName = numbersToBook.get(bookId);

    const verses = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);
    if (!verses || verses.length === 0) {
        logger.error(`[DailyVerse] Couldn't fetch text for ${bookName} ${chapter}:${startVerse}-${endVerse}`);
        return null;
    }
    verses.sort((a, b) => a.verse - b.verse);

    let body = '';
    let truncated = false;
    for (const v of verses) {
        const text = v[translation] || v.BSB;
        if (!text) continue;
        const chunk = (body ? ' ' : '') + (startVerse === endVerse ? text : `**${v.verse}** ${text}`);
        if (body.length + chunk.length > MAX_BODY_CHARS) {
            truncated = true;
            break;
        }
        body += chunk;
    }
    if (!body) return null;
    if (truncated) body += '\n\n*Truncated.*';

    const dateString = date.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    return buildDailyVerseComponents({
        bookId, bookName, chapter, startVerse, endVerse, body, translation, dateString
    });
}
