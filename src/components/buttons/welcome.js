import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
    MessageFlags,
} from 'discord.js';
import { toOSIS3Codes, toCommentaryVariants, numbersToBook } from '../../utils/bookNames.js';
import { fathersWrapper, commentaryWrapper } from '../../utils/studyHelper.js';
import { bibleWrapper } from '../../utils/bibleHelper.js';
import { fetchRandomVerseData, buildRandomVerseComponents } from '../../utils/randomVerseRenderer.js';
import { renderInterlinearEphemeral } from '../../utils/interlinearRenderer.js';
import { accentColor, footerLine } from '../../utils/theme.js';
import { attachPageCollector, isExpiredInteractionError } from '../../utils/paginationHelper.js';
import { buildFindPage, VERSES_PER_PAGE } from '../../commands/find.js';
import { fetchCrossrefData, buildCrossrefPage, REFS_PER_PAGE } from '../../commands/crossref.js';
import { buildHelpPage } from '../../commands/help.js';
import logger from '../../utils/logger.js';

const EPHEMERAL_V2 = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;
const DEMO_TRUNCATE = 1200;

function truncate(text, max = DEMO_TRUNCATE) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

function simpleContainer(title, body, footer) {
    return [new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine(footer)))];
}

// Reuse the real random-verse renderer so the demo IS the real feature — same
// four openverse buttons (Interlinear / Commentary / Cross-refs / Parallel) +
// the [🎲 Another] refresh button. Avoids drift between demo and real UX.
async function handleRandom(interaction, database) {
    let preferredTranslation = 'BSB';
    try {
        const userPref = await database.getUserValue(interaction.user.id);
        if (userPref?.translation) preferredTranslation = userPref.translation;
    } catch { /* fall through to BSB */ }

    const data = await fetchRandomVerseData({ preferredTranslation });
    if (!data) {
        return interaction.reply({ content: 'Could not fetch a random verse right now.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
        flags: EPHEMERAL_V2,
        components: buildRandomVerseComponents({ data, filterBookId: 0, filterChapter: 0 }),
    });
}

async function handleFathers(interaction) {
    const books = toCommentaryVariants('John');   // ['john']

    // Prefer Augustine specifically for the demo — he's one of the most
    // recognizable Fathers and his Tractate 12 on John 3:16 is substantial.
    // Fall back to alphabetical-first if no Augustine entry exists on this verse.
    let rows = await fathersWrapper.getByPassage(books, 3, 16, 'Augustine');
    let augustineMatched = rows && rows.length > 0;
    if (!augustineMatched) {
        rows = await fathersWrapper.getByPassage(books, 3, 16);
    }
    if (!rows || rows.length === 0) {
        return interaction.reply({ content: 'No Church Fathers data found for John 3:16.', flags: MessageFlags.Ephemeral });
    }

    const first = rows[0];
    const preview = truncate(first.txt);
    const tailNote = augustineMatched
        ? `\n\n*Run /fathers book:John chapter:3 verse:16 for all fathers on this verse.*`
        : `\n\n*+ ${rows.length - 1} more father${rows.length - 1 === 1 ? '' : 's'} — /fathers book:John chapter:3 verse:16 for the full list.*`;

    return interaction.reply({
        flags: EPHEMERAL_V2,
        components: simpleContainer(
            `## 📚 ${first.father_name} on John 3:16`,
            preview + tailNote,
            first.source_title || 'Church Fathers'
        ),
    });
}

async function handleCommentary(interaction) {
    const bookCodes = toOSIS3Codes(45);    // Romans
    const row = await commentaryWrapper.getVerseCommentary('adam-clarke', bookCodes, 8, 28);
    if (!row?.text) {
        return interaction.reply({ content: 'No commentary found for Romans 8:28.', flags: MessageFlags.Ephemeral });
    }
    return interaction.reply({
        flags: EPHEMERAL_V2,
        components: simpleContainer(
            '## Adam Clarke on Romans 8:28',
            truncate(row.text),
            'Switch commentators via /commentary book:Romans chapter:8 verse:28.'
        ),
    });
}

// Find demo — pre-baked "meaning of life" verses + the exact `buildFindPage`
// renderer that /find uses. Output is pixel-identical to the slash command;
// the demo fires instantly without an OpenAI call (saving tokens + avoiding
// the /find rate limit on a welcome-card click path).
const FIND_DEMO_TOPIC = "What's the meaning of life?";
const FIND_DEMO_REFS = [
    { bookId: 21, chapter: 12, startVerse: 13, endVerse: 14 },  // Ecclesiastes 12:13-14
    { bookId: 43, chapter: 10, startVerse: 10, endVerse: 10 },  // John 10:10
    { bookId: 43, chapter: 17, startVerse: 3,  endVerse: 3  },  // John 17:3
    { bookId: 41, chapter: 12, startVerse: 30, endVerse: 31 },  // Mark 12:30-31
    { bookId: 46, chapter: 10, startVerse: 31, endVerse: 31 },  // 1 Cor 10:31
];
const FIND_VERSE_TRUNCATE = 300;

async function handleFind(interaction) {
    const translation = 'BSB';

    // Build `verses` array in the shape buildFindPage expects. Mirrors
    // what /find's resolveVerses produces internally.
    const verses = [];
    for (const ref of FIND_DEMO_REFS) {
        try {
            const rows = await bibleWrapper.getVerses(ref.bookId, ref.chapter, ref.startVerse, ref.endVerse);
            if (!rows || rows.length === 0) continue;
            const text = rows.map((v, idx) => {
                const num = ref.startVerse + idx;
                const t = v[translation];
                if (!t) return `[${translation} unavailable]`;
                return (idx > 0 ? ` **${num}** ` : '') + t;
            }).join('');
            if (!text) continue;
            const bookName = numbersToBook.get(ref.bookId);
            const rangeLabel = ref.endVerse !== ref.startVerse
                ? `${bookName} ${ref.chapter}:${ref.startVerse}-${ref.endVerse}`
                : `${bookName} ${ref.chapter}:${ref.startVerse}`;
            const truncatedText = text.length > FIND_VERSE_TRUNCATE
                ? text.substring(0, FIND_VERSE_TRUNCATE - 1) + '…'
                : text;
            verses.push({
                bookId: ref.bookId, bookName, chapter: ref.chapter,
                startVerse: ref.startVerse, endVerse: ref.endVerse,
                rangeLabel, text: truncatedText,
            });
        } catch (err) {
            logger.debug(`[Welcome Find] Skipped ref: ${err.message}`);
        }
    }

    if (verses.length === 0) {
        return interaction.reply({ content: 'Find demo data unavailable right now.', flags: MessageFlags.Ephemeral });
    }

    const totalPages = Math.ceil(verses.length / VERSES_PER_PAGE);
    return interaction.reply({
        flags: EPHEMERAL_V2,
        components: buildFindPage({ verses, pageIdx: 0, totalPages, topic: FIND_DEMO_TOPIC, translation }),
    });
}

async function handleInterlinear(interaction, database) {
    let translation = 'BSB';
    try {
        const pref = await database.getUserValue(interaction.user.id);
        if (pref?.translation) translation = pref.translation;
    } catch { /* default to BSB */ }

    return renderInterlinearEphemeral({
        interaction,
        bookId: 43, chapter: 3, verse: 16,
        translation,
    });
}

// Cross-refs demo — uses /crossref's exact data pipeline and page renderer,
// including pagination. John 1:1 has plenty of cross-refs so the demo shows
// the full pagination UX.
async function handleCrossrefs(interaction, database) {
    let translation = 'BSB';
    try {
        const pref = await database.getUserValue(interaction.user.id);
        if (pref?.translation) translation = pref.translation;
    } catch { /* default to BSB */ }

    await interaction.deferReply({ flags: EPHEMERAL_V2 });

    const data = await fetchCrossrefData({
        bookId: 43, bookName: 'John', chapter: 1, verse: 1, translation,
    });
    if (!data || data.refs.length === 0) {
        return interaction.editReply({
            flags: EPHEMERAL_V2,
            components: [new TextDisplayBuilder().setContent('No cross-references found for John 1:1.')],
        });
    }

    const totalPages = Math.ceil(data.refs.length / REFS_PER_PAGE);
    const message = await interaction.editReply({
        flags: EPHEMERAL_V2,
        components: buildCrossrefPage({ data, pageIdx: 0, totalPages }),
    });
    if (totalPages <= 1) return;

    // Attach pagination collector scoped to this user — same UX as /crossref.
    attachPageCollector({
        interaction, message, totalPages,
        logLabel: '[Welcome Crossrefs]',
        render: (pageIdx, { disableNav }) =>
            buildCrossrefPage({ data, pageIdx, totalPages, disableNav }),
    });
}

// Help demo — renders the exact /help panel (overview + category dropdown),
// attaches a collector for category switching. Identical UX to running /help.
const HELP_COLLECTOR_TIMEOUT_MS = 600_000;

async function handleHelp(interaction) {
    let currentId = 'overview';
    const flags = MessageFlags.Ephemeral | MessageFlags.IsComponentsV2;

    await interaction.reply({
        flags,
        components: buildHelpPage(currentId),
    });

    const message = await interaction.fetchReply();
    const filter = i => i.user.id === interaction.user.id && i.customId === 'help_category';
    const collector = message.createMessageComponentCollector({
        filter,
        componentType: ComponentType.StringSelect,
        time: HELP_COLLECTOR_TIMEOUT_MS,
    });
    collector.on('collect', async i => {
        try {
            await i.deferUpdate();
            currentId = i.values[0];
            await i.editReply({ flags, components: buildHelpPage(currentId) });
        } catch (err) {
            if (!isExpiredInteractionError(err)) {
                logger.error(`[Welcome Help] Collector error: ${err.message}`);
            }
        }
    });
}

// Welcome-card demo buttons. customId format: "welcome:<action>". Dispatched
// from src/events/interactionCreate.js via the colon-prefix button lookup.
// Replies are ephemeral so the channel doesn't get spammed when multiple
// users click through the demo at the same time.
export default {
    id: 'welcome',
    async execute(interaction, database) {
        const [, action] = interaction.customId.split(':');
        try {
            switch (action) {
                case 'find':        return await handleFind(interaction);
                case 'random':      return await handleRandom(interaction, database);
                case 'interlinear': return await handleInterlinear(interaction, database);
                case 'fathers':     return await handleFathers(interaction);
                case 'commentary':  return await handleCommentary(interaction);
                case 'crossrefs':   return await handleCrossrefs(interaction, database);
                case 'help':        return await handleHelp(interaction);
                default:
                    logger.warn(`[Welcome Button] Unknown action: ${action}`);
                    return interaction.reply({ content: 'Unknown action.', flags: MessageFlags.Ephemeral });
            }
        } catch (err) {
            logger.error(`[Welcome Button] ${action} failed: ${err.message}`);
            if (!interaction.replied && !interaction.deferred) {
                try {
                    await interaction.reply({ content: 'Something went wrong running that demo.', flags: MessageFlags.Ephemeral });
                } catch { /* interaction likely expired */ }
            }
        }
    },
};
