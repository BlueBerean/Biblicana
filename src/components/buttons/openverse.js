import {
    EmbedBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
    MessageFlags
} from 'discord.js';
import { bibleWrapper, numbersToBook, getBookId } from '../../utils/bibleHelper.js';
import { commentaryWrapper, crossRefWrapper, toCommentaryBookCodes, COMMENTATORS } from '../../utils/studyHelper.js';
import { renderInterlinearEphemeral } from '../../utils/interlinearRenderer.js';
import { renderParallelEphemeral } from '../../utils/parallelRenderer.js';
import { renderBibleEphemeral } from '../../utils/bibleRenderer.js';
import { accentColor, footerLine } from '../../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../../utils/paginationHelper.js';
import logger from '../../utils/logger.js';
import 'dotenv/config';

const COMMENTARY_MAX_CHARS = 3800;
const XREF_MAX_FETCH = 50;
const XREF_PER_PAGE = 8;
const COLLECTOR_TIMEOUT_MS = 600_000;

// Fallback order for /bible's [Commentary] button. Adam Clarke first (our
// default), then the others. Keil is filtered out for NT books at the call
// site (he only covers OT); Tyndale has no chapter-level intros.
const COMMENTARY_FALLBACK_ORDER = [
    'adam-clarke',
    'jamieson-fausset-brown',
    'john-gill',
    'matthew-henry',
    'keil-delitzsch',
    'tyndale'
];

async function userTranslation(database, userId) {
    try {
        const userPref = await database.getUserValue(userId);
        if (userPref?.translation) return userPref.translation;
    } catch (dbError) {
        logger.error(`[OpenVerse Button] Failed to get user preference: ${dbError.message}`);
    }
    return 'BSB';
}

function baseEmbedColor() {
    return process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
}

function standardFooter(extra = '') {
    const suffix = extra ? ` | ${extra}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT || ''}${suffix}`.trim(),
        iconURL: process.env.EMBEDICONURL
    };
}

// --- Interlinear ----------------------------------------------------------

async function handleInterlinear({ interaction, bookId, chapter, verse, translation }) {
    await renderInterlinearEphemeral({ interaction, bookId, chapter, verse, translation });
}

async function handleBible({ interaction, bookId, chapter, startVerse, endVerse, translation }) {
    await renderBibleEphemeral({ interaction, bookId, chapter, startVerse, endVerse, translation });
}

// Opens a full chapter as a verse range (1..200). bibleRenderer truncates long
// chapter bodies — typical chapters are 20-50 verses and fit comfortably.
async function handleChapter({ interaction, bookId, chapter, translation }) {
    await renderBibleEphemeral({
        interaction,
        bookId,
        chapter,
        startVerse: 1,
        endVerse: 200,
        translation
    });
}

// --- Commentary (with fallback chain + commentator dropdown) -------------

function buildChapterCommentaryEmbed({ commentator, text, bookName, chapter }) {
    const truncated = text.length > COMMENTARY_MAX_CHARS;
    const body = truncated ? text.substring(0, COMMENTARY_MAX_CHARS - 3) + '...' : text;
    const hint = truncated
        ? `\n\n*Truncated. Run \`/commentary book:${bookName} chapter:${chapter} commentator:${commentator.id}\` for the full text.*`
        : '';

    return new EmbedBuilder()
        .setColor(baseEmbedColor())
        .setTitle(`📚 ${commentator.label}: ${bookName} ${chapter} (chapter intro)`)
        .setDescription(body + hint)
        .setURL(process.env.WEBSITE)
        .setFooter(standardFooter(commentator.label));
}

// Chapter-level commentary path. Tyndale has no chapter intros (skip); Keil is
// OT-only. Fall through remaining commentators in order and also expose a
// SelectMenu so the user can swap commentators without leaving the reply.
async function handleChapterCommentary({ interaction, bookId, bookCodes, chapter, bookName }) {
    const isNT = bookId > 39;
    const availableIds = [
        'adam-clarke',
        'jamieson-fausset-brown',
        'john-gill',
        'matthew-henry',
        'keil-delitzsch'
    ].filter(id => !(id === 'keil-delitzsch' && isNT));

    let found = null;
    for (const id of availableIds) {
        const row = await commentaryWrapper.getChapterCommentary(id, bookCodes, chapter);
        if (row?.introduction) {
            found = { commentatorId: id, text: row.introduction };
            break;
        }
    }

    if (!found) {
        return interaction.reply({
            content: `No chapter-level introduction available for ${bookName} ${chapter} from any commentator.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const available = COMMENTATORS.filter(c => availableIds.includes(c.id));
    let currentId = found.commentatorId;
    const current = COMMENTATORS.find(c => c.id === currentId);

    await interaction.reply({
        embeds: [buildChapterCommentaryEmbed({ commentator: current, text: found.text, bookName, chapter })],
        components: [buildCommentarySelect({ availableCommentators: available, currentId })],
        flags: MessageFlags.Ephemeral
    });

    try {
        const message = await interaction.fetchReply();
        const filter = i => i.user.id === interaction.user.id && i.customId === 'cmtr_select';
        const collector = message.createMessageComponentCollector({
            filter,
            componentType: ComponentType.StringSelect,
            time: COLLECTOR_TIMEOUT_MS
        });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                const pickedId = i.values[0];
                const picked = COMMENTATORS.find(c => c.id === pickedId);
                if (!picked) return;

                const row = await commentaryWrapper.getChapterCommentary(pickedId, bookCodes, chapter);
                if (!row?.introduction) {
                    const noDataEmbed = new EmbedBuilder()
                        .setColor(baseEmbedColor())
                        .setTitle(`📚 ${picked.label}: ${bookName} ${chapter} (chapter intro)`)
                        .setDescription(`*${picked.label} doesn't have a chapter-level introduction for **${bookName} ${chapter}**. Pick another commentator from the dropdown.*`)
                        .setURL(process.env.WEBSITE)
                        .setFooter(standardFooter(picked.label));
                    await i.editReply({
                        embeds: [noDataEmbed],
                        components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                    });
                    return;
                }

                currentId = pickedId;
                await i.editReply({
                    embeds: [buildChapterCommentaryEmbed({ commentator: picked, text: row.introduction, bookName, chapter })],
                    components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                });
            } catch (err) {
                logger.error(`[OpenVerse ChapterCommentary] Collector error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({
                    components: [buildCommentarySelect({ availableCommentators: available, currentId, disabled: true })]
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    logger.error(`[OpenVerse ChapterCommentary] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        logger.error(`[OpenVerse ChapterCommentary] Setup error: ${err.message}`);
    }
}

async function fetchCommentaryWithFallback({ bookId, chapter, verse, preferredId = 'adam-clarke' }) {
    const bookCodes = toCommentaryBookCodes(bookId);
    if (bookCodes.length === 0) return null;

    const isNT = bookId > 39;
    // Preferred first, then the rest in canonical fallback order (deduped).
    const order = [preferredId, ...COMMENTARY_FALLBACK_ORDER.filter(id => id !== preferredId)];

    for (const id of order) {
        if (id === 'keil-delitzsch' && isNT) continue;
        const row = await commentaryWrapper.getVerseCommentary(id, bookCodes, chapter, verse);
        if (row?.text) return { commentatorId: id, text: row.text };
    }
    return null;
}

function buildCommentaryEmbed({ commentator, text, bookName, chapter, verse, wasFallback = false, preferredLabel = null }) {
    const truncated = text.length > COMMENTARY_MAX_CHARS;
    const body = truncated ? text.substring(0, COMMENTARY_MAX_CHARS - 3) + '...' : text;
    const notes = [];
    if (wasFallback && preferredLabel) {
        notes.push(`*${preferredLabel} had no commentary on this verse — showing ${commentator.label} instead. Switch commentators below.*`);
    }
    if (truncated) {
        notes.push(`*Truncated. Run \`/commentary book:${bookName} chapter:${chapter} verse:${verse} commentator:${commentator.id}\` for full text.*`);
    }
    const description = notes.length > 0 ? `${notes.join('\n\n')}\n\n${body}` : body;

    return new EmbedBuilder()
        .setColor(baseEmbedColor())
        .setTitle(`📚 ${commentator.label}: ${bookName} ${chapter}:${verse}`)
        .setDescription(description)
        .setURL(process.env.WEBSITE)
        .setFooter(standardFooter(commentator.label));
}

function buildCommentarySelect({ availableCommentators, currentId, disabled = false }) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cmtr_select')
            .setPlaceholder('Switch commentator')
            .setDisabled(disabled)
            .addOptions(availableCommentators.map(c => ({
                label: c.label,
                value: c.id,
                default: c.id === currentId
            })))
    );
}

async function handleCommentary({ interaction, bookId, chapter, verse, bookName }) {
    const bookCodes = toCommentaryBookCodes(bookId);
    if (bookCodes.length === 0) {
        return interaction.reply({
            content: `Commentary isn't supported for ${bookName}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // verse=0 sentinel means "chapter-level commentary" (used by /audio and
    // future callers that want the chapter introduction rather than a verse note).
    const isChapterLevel = verse === 0;
    if (isChapterLevel) {
        return handleChapterCommentary({ interaction, bookId, bookCodes, chapter, bookName });
    }

    const result = await fetchCommentaryWithFallback({ bookId, chapter, verse });
    if (!result) {
        return interaction.reply({
            content: `No commentary available on ${bookName} ${chapter}:${verse} from any of the 6 commentators.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const preferredId = COMMENTARY_FALLBACK_ORDER[0]; // Adam Clarke
    const wasFallback = result.commentatorId !== preferredId;
    const preferred = COMMENTATORS.find(c => c.id === preferredId);
    let currentId = result.commentatorId;
    const current = COMMENTATORS.find(c => c.id === currentId);

    const isNT = bookId > 39;
    const available = COMMENTATORS.filter(c => !(c.id === 'keil-delitzsch' && isNT));

    const embed = buildCommentaryEmbed({
        commentator: current,
        text: result.text,
        bookName, chapter, verse,
        wasFallback,
        preferredLabel: preferred?.label
    });
    const selectRow = buildCommentarySelect({ availableCommentators: available, currentId });

    await interaction.reply({
        embeds: [embed],
        components: [selectRow],
        flags: MessageFlags.Ephemeral
    });

    try {
        const message = await interaction.fetchReply();
        const filter = i => i.user.id === interaction.user.id && i.customId === 'cmtr_select';
        const collector = message.createMessageComponentCollector({
            filter,
            componentType: ComponentType.StringSelect,
            time: COLLECTOR_TIMEOUT_MS
        });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                const pickedId = i.values[0];
                const picked = COMMENTATORS.find(c => c.id === pickedId);
                if (!picked) return;

                const row = await commentaryWrapper.getVerseCommentary(pickedId, bookCodes, chapter, verse);
                if (!row?.text) {
                    const noDataEmbed = new EmbedBuilder()
                        .setColor(baseEmbedColor())
                        .setTitle(`📚 ${picked.label}: ${bookName} ${chapter}:${verse}`)
                        .setDescription(`*${picked.label} doesn't have commentary on **${bookName} ${chapter}:${verse}**. Pick another commentator from the dropdown.*`)
                        .setURL(process.env.WEBSITE)
                        .setFooter(standardFooter(picked.label));
                    await i.editReply({
                        embeds: [noDataEmbed],
                        components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                    });
                    return;
                }

                currentId = pickedId;
                await i.editReply({
                    embeds: [buildCommentaryEmbed({ commentator: picked, text: row.text, bookName, chapter, verse })],
                    components: [buildCommentarySelect({ availableCommentators: available, currentId: pickedId })]
                });
            } catch (err) {
                logger.error(`[OpenVerse Commentary] Collector error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({
                    components: [buildCommentarySelect({ availableCommentators: available, currentId, disabled: true })]
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    logger.error(`[OpenVerse Commentary] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        logger.error(`[OpenVerse Commentary] Setup error: ${err.message}`);
    }
}

// --- Crossref (paginated) -------------------------------------------------

function buildXrefPage({ processed, sourceLabel, sourceText, translation, pageIdx, totalPages, totalRefCount, disableNav = false }) {
    const start = pageIdx * XREF_PER_PAGE;
    const pageRefs = processed.slice(start, start + XREF_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 🔗 Cross References — ${sourceLabel}${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**${translation.toUpperCase()}:** ${sourceText}`
        ));

    pageRefs.forEach((ref, localIdx) => {
        const globalIdx = start + localIdx;
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${ref.label}** — ${ref.text}`))
                .setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`openverse:bible:${ref.bookId}:${ref.chapter}:${ref.startVerse}:${ref.endVerse}:x${globalIdx}`)
                        .setLabel('Open')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                )
        );
    });

    const shownSuffix = totalRefCount > processed.length
        ? ` | ${processed.length} of ${totalRefCount} shown`
        : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`Translation: ${translation.toUpperCase()}${shownSuffix}`)
    ));

    const components = [container];
    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

async function handleCrossref({ interaction, bookId, chapter, verse, bookName, translation }) {
    // Same shape as /crossref command — Section-per-ref with [📖 Open] buttons
    // that chain back into openverse:bible so the user can drill into any ref.
    const [refsResult, sourceResult] = await Promise.allSettled([
        crossRefWrapper.getForVerse(bookName, chapter, verse),
        bibleWrapper.getVerses(bookId, chapter, verse, verse)
    ]);

    if (refsResult.status === 'rejected' || !refsResult.value || refsResult.value.length === 0) {
        return interaction.reply({
            content: `No cross-references found for ${bookName} ${chapter}:${verse}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const refs = refsResult.value;
    const sourceText = (sourceResult.status === 'fulfilled' && sourceResult.value?.[0])
        ? (sourceResult.value[0][translation] || sourceResult.value[0].BSB || '')
        : '';
    const sourceLabel = `${bookName} ${chapter}:${verse}`;

    const fetchable = refs.slice(0, XREF_MAX_FETCH);

    const processed = (await Promise.allSettled(fetchable.map(async ref => {
        const refBookId = getBookId(ref.target_book);
        const refBookName = refBookId ? numbersToBook.get(refBookId) : null;
        if (!refBookId || !refBookName) return null;

        const endVerse = ref.target_verse_end || ref.target_verse_start;
        const data = await bibleWrapper.getVerses(refBookId, ref.target_chapter, ref.target_verse_start, endVerse);
        if (!data || data.length === 0) return null;

        const text = data.map(v => v[translation] || v.BSB).filter(Boolean).join(' ');
        if (!text) return null;

        const rangeLabel = endVerse > ref.target_verse_start
            ? `${refBookName} ${ref.target_chapter}:${ref.target_verse_start}-${endVerse}`
            : `${refBookName} ${ref.target_chapter}:${ref.target_verse_start}`;
        return {
            label: rangeLabel,
            text: text.length > 300 ? text.substring(0, 299) + '…' : text,
            bookId: refBookId,
            chapter: ref.target_chapter,
            startVerse: ref.target_verse_start,
            endVerse
        };
    })))
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value);

    if (processed.length === 0) {
        return interaction.reply({
            content: `Cross-references found but couldn't retrieve verse text in ${translation.toUpperCase()}.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const totalPages = Math.ceil(processed.length / XREF_PER_PAGE);

    await interaction.reply({
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: buildXrefPage({
            processed, sourceLabel, sourceText, translation,
            pageIdx: 0, totalPages, totalRefCount: refs.length
        })
    });

    if (totalPages <= 1) return;

    const message = await interaction.fetchReply();
    attachPageCollector({
        interaction, message, totalPages,
        logLabel: '[OpenVerse Xref]',
        render: (pageIdx, { disableNav }) =>
            buildXrefPage({
                processed, sourceLabel, sourceText, translation,
                pageIdx, totalPages, totalRefCount: refs.length, disableNav
            })
    });
}

// --- Parallel (single page, all translations local) ----------------------

async function handleParallel({ interaction, bookId, chapter, verse, translation }) {
    await renderParallelEphemeral({ interaction, bookId, chapter, verse, primaryTranslation: translation });
}

// --- Dispatcher -----------------------------------------------------------

export default {
    id: 'openverse',
    async execute(interaction, database) {
        // customId format: `openverse:<action>:<bookId>:<chapter>:<startVerse>[:<endVerse>[:<occurrenceIdx>]]`
        // The optional 6th part encodes an end verse for range lookups.
        // The optional 7th part is a free-form uniqueness suffix (used when the
        // same verse ref appears multiple times in one message — e.g., duplicate
        // Messianic prophecy refs in /propheciesofjesus, duplicate commentary
        // contexts in /topic). The handler ignores it.
        const parts = interaction.customId.split(':');
        if (parts.length < 5 || parts.length > 7) {
            logger.warn(`[OpenVerse Button] Malformed customId: ${interaction.customId}`);
            return interaction.reply({ content: 'Invalid action.', flags: MessageFlags.Ephemeral });
        }

        const [, action, bookIdStr, chapterStr, startVerseStr, endVerseStr] = parts;
        const bookId = parseInt(bookIdStr);
        const chapter = parseInt(chapterStr);
        const startVerse = parseInt(startVerseStr);
        const endVerse = endVerseStr ? parseInt(endVerseStr) : startVerse;
        const bookName = numbersToBook.get(bookId);

        if (!bookName || isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) {
            return interaction.reply({ content: 'Invalid verse reference.', flags: MessageFlags.Ephemeral });
        }

        const translation = await userTranslation(database, interaction.user.id);

        try {
            switch (action) {
                case 'bible':
                    return await handleBible({ interaction, bookId, chapter, startVerse, endVerse, translation });
                case 'chapter':
                    return await handleChapter({ interaction, bookId, chapter, translation });
                case 'interlinear':
                    return await handleInterlinear({ interaction, bookId, chapter, verse: startVerse, translation });
                case 'commentary':
                    return await handleCommentary({ interaction, bookId, chapter, verse: startVerse, bookName });
                case 'xref':
                    return await handleCrossref({ interaction, bookId, chapter, verse: startVerse, bookName, translation });
                case 'parallel':
                    return await handleParallel({ interaction, bookId, chapter, verse: startVerse, translation });
                default:
                    return interaction.reply({ content: `Unknown action: ${action}`, flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error(`[OpenVerse Button] Error handling ${action} for ${bookName} ${chapter}:${startVerse}: ${error.message}`, error.stack);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: `Sorry, couldn't load ${action}. ${error.message}`,
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (replyError) {
                logger.error(`[OpenVerse Button] Failed to send error reply: ${replyError.message}`);
            }
        }
    }
};
