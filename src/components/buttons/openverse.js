import {
    EmbedBuilder,
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
import logger from '../../utils/logger.js';
import 'dotenv/config';

const COMMENTARY_MAX_CHARS = 3800;
const XREF_MAX_FETCH = 50;
const XREF_PER_PAGE = 8;
const COLLECTOR_TIMEOUT_MS = 600_000;

// Fallback order for /bible's [Commentary] button. JFB first (our default),
// then the other five commentators. Keil is filtered out for NT books at the
// call site (he only covers OT).
const COMMENTARY_FALLBACK_ORDER = [
    'jamieson-fausset-brown',
    'john-gill',
    'matthew-henry',
    'adam-clarke',
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

// --- Commentary (with fallback chain + commentator dropdown) -------------

async function fetchCommentaryWithFallback({ bookId, chapter, verse, preferredId = 'jamieson-fausset-brown' }) {
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

    const result = await fetchCommentaryWithFallback({ bookId, chapter, verse });
    if (!result) {
        return interaction.reply({
            content: `No commentary available on ${bookName} ${chapter}:${verse} from any of the 6 commentators.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const preferredId = COMMENTARY_FALLBACK_ORDER[0]; // JFB
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

async function handleCrossref({ interaction, bookId, chapter, verse, bookName, translation }) {
    const refs = await crossRefWrapper.getForVerse(bookName, chapter, verse);
    if (!refs || refs.length === 0) {
        return interaction.reply({
            content: `No cross-references found for ${bookName} ${chapter}:${verse}.`,
            flags: MessageFlags.Ephemeral
        });
    }

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
        return { label: rangeLabel, text };
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
    let currentPage = 0;

    const buildEmbed = (pageIdx) => {
        const start = pageIdx * XREF_PER_PAGE;
        const chunk = processed.slice(start, start + XREF_PER_PAGE);
        const body = chunk.map(r => `• **${r.label}** — ${r.text}`).join('\n\n');
        const footerSuffix = refs.length > XREF_MAX_FETCH
            ? ` | ${processed.length} of ${refs.length} refs`
            : '';
        return new EmbedBuilder()
            .setColor(baseEmbedColor())
            .setTitle(`🔗 Cross References — ${bookName} ${chapter}:${verse}`)
            .setDescription(body.substring(0, 4000))
            .setURL(process.env.WEBSITE)
            .setFooter(standardFooter(
                `Translation: ${translation.toUpperCase()} | Page ${pageIdx + 1}/${totalPages}${footerSuffix}`
            ));
    };

    const buildRow = (pageIdx, disabled = false) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji({ name: '◀️' })
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || pageIdx === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji({ name: '▶️' })
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || pageIdx === totalPages - 1)
    );

    await interaction.reply({
        embeds: [buildEmbed(0)],
        components: totalPages > 1 ? [buildRow(0)] : [],
        flags: MessageFlags.Ephemeral
    });

    if (totalPages <= 1) return;

    try {
        const message = await interaction.fetchReply();
        const filter = i => i.user.id === interaction.user.id &&
            (i.customId === 'page_back' || i.customId === 'page_next');
        const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                if (i.customId === 'page_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
                else currentPage = Math.max(0, currentPage - 1);
                await i.editReply({ embeds: [buildEmbed(currentPage)], components: [buildRow(currentPage)] });
            } catch (err) {
                logger.error(`[OpenVerse Xref] Pagination error: ${err.message}`);
            }
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({
                    embeds: [buildEmbed(currentPage)],
                    components: [buildRow(currentPage, true)]
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    logger.error(`[OpenVerse Xref] End error: ${err.message}`);
                }
            }
        });
    } catch (err) {
        logger.error(`[OpenVerse Xref] Setup error: ${err.message}`);
    }
}

// --- Parallel (single page, all translations local) ----------------------

async function handleParallel({ interaction, bookId, chapter, verse, translation }) {
    await renderParallelEphemeral({ interaction, bookId, chapter, verse, primaryTranslation: translation });
}

// --- Dispatcher -----------------------------------------------------------

export default {
    id: 'openverse',
    async execute(interaction, database) {
        // customId format: `openverse:<action>:<bookId>:<chapter>:<verse>`
        const parts = interaction.customId.split(':');
        if (parts.length !== 5) {
            logger.warn(`[OpenVerse Button] Malformed customId: ${interaction.customId}`);
            return interaction.reply({ content: 'Invalid action.', flags: MessageFlags.Ephemeral });
        }

        const [, action, bookIdStr, chapterStr, verseStr] = parts;
        const bookId = parseInt(bookIdStr);
        const chapter = parseInt(chapterStr);
        const verse = parseInt(verseStr);
        const bookName = numbersToBook.get(bookId);

        if (!bookName || isNaN(chapter) || isNaN(verse)) {
            return interaction.reply({ content: 'Invalid verse reference.', flags: MessageFlags.Ephemeral });
        }

        const translation = await userTranslation(database, interaction.user.id);

        try {
            switch (action) {
                case 'interlinear':
                    return await handleInterlinear({ interaction, bookId, chapter, verse, translation });
                case 'commentary':
                    return await handleCommentary({ interaction, bookId, chapter, verse, bookName });
                case 'xref':
                    return await handleCrossref({ interaction, bookId, chapter, verse, bookName, translation });
                case 'parallel':
                    return await handleParallel({ interaction, bookId, chapter, verse, translation });
                default:
                    return interaction.reply({ content: `Unknown action: ${action}`, flags: MessageFlags.Ephemeral });
            }
        } catch (error) {
            logger.error(`[OpenVerse Button] Error handling ${action} for ${bookName} ${chapter}:${verse}: ${error.message}`, error.stack);
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
