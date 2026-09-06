import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags
} from 'discord.js';
import { bibleWrapper } from './bibleHelper.js';
import { numbersToBook } from './bookNames.js';
import { accentColor, footerLine } from './theme.js';
import { respondToInteraction } from './paginationHelper.js';

const MAX_BODY_CHARS = 3800;

/**
 * Builds the 4-button action row (Interlinear, Commentary, Cross-refs, Parallel)
 * for a given single verse. Used by /bible, /randomverse, and the openverse
 * 'bible' action when rendering a verse with explore actions.
 */
export function buildVerseActionRow(bookId, chapter, verse) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${bookId}:${chapter}:${verse}`)
            .setLabel('Interlinear')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:${verse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${bookId}:${chapter}:${verse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${bookId}:${chapter}:${verse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary)
    );
}

/**
 * Fetches verse text for a single verse or range, returns null if none found.
 * Returns the formatted body text with verse numbers, truncation indicator,
 * and a canonical range label ready for display.
 */
export async function fetchBibleVerseData({ bookId, chapter, startVerse, endVerse = null, translation }) {
    const effectiveEnd = endVerse || startVerse;
    const bookName = numbersToBook.get(bookId);
    if (!bookName) return null;

    const verses = await bibleWrapper.getVerses(bookId, chapter, startVerse, effectiveEnd);
    if (!verses || verses.length === 0) return null;

    verses.sort((a, b) => a.verse - b.verse);

    let body = '';
    let truncated = false;
    for (const v of verses) {
        const text = v[translation];
        if (!text) continue;
        const nextChunk = (body ? ' ' : '') + `**${v.verse}** ${text}`;
        if (body.length + nextChunk.length > MAX_BODY_CHARS) {
            truncated = true;
            break;
        }
        body += nextChunk;
    }
    if (!body) return null;
    // No "try a smaller range" note any more: that put the work back on the
    // reader for something the bot can just do. buildBibleComponents turns the
    // flag into a Read full button instead.
    if (truncated) body += '…';

    const rangeLabel = effectiveEnd !== startVerse
        ? `${bookName} ${chapter}:${startVerse}-${effectiveEnd}`
        : `${bookName} ${chapter}:${startVerse}`;

    return {
        bookId,
        bookName,
        chapter,
        startVerse,
        endVerse: effectiveEnd,
        body,
        translation,
        rangeLabel,
        truncated,
    };
}

/**
 * Builds a V2 response for a verse or verse range. Only attaches the 4-action
 * button row for single-verse responses (ranges have no single verse to
 * interlinear/commentary/etc on).
 */
export function buildBibleComponents({ data, includeActionRow = true }) {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${data.rangeLabel}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(data.body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`Translation: ${data.translation.toUpperCase()}`)
        ));

    const components = [container];

    // A single verse gets the study chain. A RANGE previously got nothing at
    // all — so a range long enough to be cut had no controls whatsoever, which
    // is how "try a smaller range" ended up being the only way forward. This is
    // the terminus of every Open button in the bot (/find, /topicalindex,
    // /topic, /propheciesofjesus and the passive cards all land here), so a
    // dead end here is a dead end everywhere.
    const row = includeActionRow && data.startVerse === data.endVerse
        ? buildVerseActionRow(data.bookId, data.chapter, data.startVerse)
        : new ActionRowBuilder();

    if (data.truncated) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`passageread:${data.bookId}:${data.chapter}:${data.startVerse}:${data.endVerse}`)
                .setLabel('Read full')
                .setEmoji({ name: '📜' })
                .setStyle(ButtonStyle.Primary)
        );
    }

    // An empty row is not a valid component — only push one that has buttons.
    if (row.components.length > 0) components.push(row);
    return components;
}

/**
 * Convenience helper for button handlers that need to render a verse or range
 * ephemerally — used by the openverse 'bible' action dispatched from /profile,
 * /find, /crossref. Range mode (endVerse > startVerse) skips the action row.
 */
export async function renderBibleEphemeral({ interaction, bookId, chapter, startVerse, endVerse = null, translation }) {
    const data = await fetchBibleVerseData({ bookId, chapter, startVerse, endVerse, translation });
    if (!data) {
        // Rendered as a V2 TextDisplay rather than plain `content`: callers now
        // defer with IsComponentsV2 before calling in, and the two response
        // shapes are mutually exclusive once the defer has locked one in.
        await respondToInteraction(interaction, {
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [new TextDisplayBuilder().setContent(
                `Couldn't fetch this passage in ${translation.toUpperCase()}.`
            )],
        });
        return;
    }

    await respondToInteraction(interaction, {
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: buildBibleComponents({ data, includeActionRow: true })
    });
}
