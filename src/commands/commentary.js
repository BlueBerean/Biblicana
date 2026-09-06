import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import { getBookId, numbersToBook, toOSIS3Codes } from '../utils/bookNames.js';
import { resolveSingleChapterRef } from '../utils/scriptureRefs.js';
import { commentaryWrapper, COMMENTATORS } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { isExpiredInteractionError } from '../utils/paginationHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 3800;
const COLLECTOR_TIMEOUT_MS = 1_800_000;
const DEFAULT_COMMENTATOR_ID = 'adam-clarke';

// Tyndale verse entries are prefixed with "3:16" / "3:16-21" — strip for display.
function stripTyndaleReferencePrefix(text, commentatorId) {
    if (commentatorId !== 'tyndale' || !text) return text;
    return text.replace(/^\d+:\d+(-\d+)?\s+/, '');
}

function findCommentator(id) {
    return COMMENTATORS.find(c => c.id === id);
}

// Available commentators for this book + mode. Keil is OT-only; Tyndale has
// no chapter-level introductions.
function availableCommentators({ isNT, isChapterLevel }) {
    return COMMENTATORS.filter(c => {
        if (c.id === 'keil-delitzsch' && isNT) return false;
        if (c.id === 'tyndale' && isChapterLevel) return false;
        return true;
    });
}

// Fetch text for one commentator in the current mode.
async function fetchForCommentator({ commentatorId, bookCodes, chapter, verse, isChapterLevel }) {
    if (isChapterLevel) {
        const row = await commentaryWrapper.getChapterCommentary(commentatorId, bookCodes, chapter);
        return row?.introduction || null;
    }
    const row = await commentaryWrapper.getCommentaryForVerse(commentatorId, bookCodes, chapter, verse);
    if (!row?.text) return null;
    const text = stripTyndaleReferencePrefix(row.text, commentatorId);

    // Passage-grouped commentators (Henry, Keil) key an entire block at its
    // first verse, so the text just fetched may open several verses before the
    // one requested — Henry's note on Philippians 4:1-9 is a single entry keyed
    // at verse 1. Without this line the header reads ":6" above a note that
    // visibly starts at verse 1, which looks like the wrong result rather than
    // the way the commentator wrote.
    //
    // Returned inline rather than threaded through render state: the caller
    // splits this string into pages, so a prefix needs no plumbing.
    if (row.coveredFrom && row.coveredFrom !== verse) {
        return `-# 📖 Passage note: this commentator writes on whole passages, so the text below begins at verse ${row.coveredFrom} and covers verse ${verse}.\n\n${text}`;
    }
    return text;
}

// Try preferred commentator first, then fall through the rest in order.
async function fetchWithFallback({ preferredId, available, bookCodes, chapter, verse, isChapterLevel }) {
    const ordered = [preferredId, ...available.filter(c => c.id !== preferredId).map(c => c.id)];
    for (const id of ordered) {
        const text = await fetchForCommentator({ commentatorId: id, bookCodes, chapter, verse, isChapterLevel });
        if (text) return { commentatorId: id, text };
    }
    return null;
}

function buildCommentarySelect({ available, currentId, disabled = false }) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('cmtr_select')
            .setPlaceholder('Switch commentator')
            .setDisabled(disabled)
            .addOptions(available.map(c => ({
                label: c.label,
                value: c.id,
                default: c.id === currentId
            })))
    );
}

function buildPaginationRow({ pageIdx, totalPages, disableNav = false }) {
    return new ActionRowBuilder().addComponents(
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
}

function buildComponents({
    state,
    available,
    bookName,
    chapter,
    verseInput,
    preferredLabel,
    disableNav = false,
    disableSelect = false
}) {
    const { commentatorId, pages, pageIdx, wasFallback } = state;
    const commentator = findCommentator(commentatorId);
    const isChapterLevel = verseInput === null;
    const titleRef = isChapterLevel ? `${bookName} ${chapter}` : `${bookName} ${chapter}:${verseInput}`;
    const chapterTag = isChapterLevel ? ' (chapter intro)' : '';
    const pageInfo = pages.length > 1 ? ` (Page ${pageIdx + 1}/${pages.length})` : '';

    const headerLines = [`## 📚 ${commentator.label}: ${titleRef}${chapterTag}${pageInfo}`];
    if (wasFallback && preferredLabel) {
        headerLines.push('', `*${preferredLabel} had no commentary on this reference — showing ${commentator.label} instead. Switch below.*`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(pages[pageIdx]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine(commentator.label)));

    const components = [container, buildCommentarySelect({ available, currentId: commentatorId, disabled: disableSelect })];
    if (pages.length > 1) {
        components.push(buildPaginationRow({ pageIdx, totalPages: pages.length, disableNav }));
    }
    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('commentary')
        .setDescription("Look up Bible commentary (verse or chapter level) from classic commentators")
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want commentary for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number (omit for chapter-level commentary)')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('commentator')
                .setDescription(`Which commentator to use (default: Adam Clarke)`)
                .setRequired(false)
                .addChoices(
                    ...COMMENTATORS.map(c => ({ name: c.label, value: c.id }))
                )),

    async execute(interaction) {
        // Sync validation before defer.
        const rawBook = interaction.options.getString('book');
        const chapterInput = interaction.options.getString('chapter');
        let verseInput = interaction.options.getNumber('verse');
        const explicitCommentator = interaction.options.getString('commentator');

        let chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({
                content: 'Please provide a valid chapter number (must be 1 or greater).',
                flags: MessageFlags.Ephemeral
            });
        }

        if (verseInput !== null && (!Number.isInteger(verseInput) || verseInput < 1)) {
            return interaction.reply({
                content: 'If provided, verse must be a whole number (1 or greater).',
                flags: MessageFlags.Ephemeral
            });
        }

        const bookId = getBookId(rawBook);
        const bookName = bookId ? numbersToBook.get(bookId) : null;
        if (!bookId || !bookName) {
            return interaction.reply({
                content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                flags: MessageFlags.Ephemeral
            });
        }

        // "book:Jude chapter:5" means Jude 1:5 - Jude has only one chapter.
        ({ chapter, startVerse: verseInput } = resolveSingleChapterRef(bookId, chapter, verseInput));

        const bookCodes = toOSIS3Codes(bookId);
        if (bookCodes.length === 0) {
            return interaction.reply({
                content: `Book "${bookName}" isn't supported by the commentary database.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const isNT = bookId > 39;
            const isChapterLevel = verseInput === null;
            const available = availableCommentators({ isNT, isChapterLevel });
            const preferredId = explicitCommentator || DEFAULT_COMMENTATOR_ID;
            const preferred = findCommentator(preferredId);

            // If the user explicitly picked an unavailable commentator for this
            // mode (Keil on NT, Tyndale on chapter), surface directly.
            if (!available.some(c => c.id === preferredId)) {
                const scope = isChapterLevel ? ' chapter-level' : '';
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ ${preferred.label} isn't available for this${scope} request.`
                    )]
                });
            }

            logger.info(`[Commentary Command] Request: ${preferredId} on ${bookName} ${chapter}${isChapterLevel ? ' (chapter)' : `:${verseInput}`}`);

            const initial = await fetchWithFallback({
                preferredId, available, bookCodes, chapter, verse: verseInput, isChapterLevel
            });

            if (!initial) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No commentary available on ${bookName} ${chapter}${isChapterLevel ? '' : `:${verseInput}`} from any of the ${available.length} eligible commentators.`
                    )]
                });
            }

            const state = {
                commentatorId: initial.commentatorId,
                pages: splitString(initial.text, MAX_CHARS_PER_PAGE),
                pageIdx: 0,
                wasFallback: initial.commentatorId !== preferredId
            };

            const flags = MessageFlags.IsComponentsV2;
            await interaction.editReply({
                flags,
                components: buildComponents({
                    state, available, bookName, chapter, verseInput,
                    preferredLabel: preferred.label
                })
            });

            // Single collector handles BOTH the select-menu swap and page-nav buttons.
            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id && (
                i.customId === 'cmtr_select' ||
                i.customId === 'page_back' ||
                i.customId === 'page_next'
            );
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();

                    if (i.customId === 'cmtr_select') {
                        const pickedId = i.values[0];
                        const picked = findCommentator(pickedId);
                        const text = await fetchForCommentator({
                            commentatorId: pickedId, bookCodes, chapter, verse: verseInput, isChapterLevel
                        });

                        if (!text) {
                            state.commentatorId = pickedId;
                            state.pages = [`*${picked.label} doesn't have commentary on ${bookName} ${chapter}${isChapterLevel ? '' : `:${verseInput}`}. Pick another commentator from the dropdown.*`];
                            state.pageIdx = 0;
                            state.wasFallback = false;
                        } else {
                            state.commentatorId = pickedId;
                            state.pages = splitString(text, MAX_CHARS_PER_PAGE);
                            state.pageIdx = 0;
                            state.wasFallback = false;
                        }
                    } else if (i.customId === 'page_next') {
                        state.pageIdx = Math.min(state.pages.length - 1, state.pageIdx + 1);
                    } else if (i.customId === 'page_back') {
                        state.pageIdx = Math.max(0, state.pageIdx - 1);
                    }

                    await i.editReply({
                        flags,
                        components: buildComponents({
                            state, available, bookName, chapter, verseInput,
                            preferredLabel: preferred.label
                        })
                    });
                } catch (err) {
                    logger.error(`[Commentary Command] Collector error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                logger.info(`[Commentary Command] Collector ended for ${bookName} ${chapter}${isChapterLevel ? '' : `:${verseInput}`}`);
                try {
                    await interaction.editReply({
                        flags,
                        components: buildComponents({
                            state, available, bookName, chapter, verseInput,
                            preferredLabel: preferred.label,
                            disableNav: true,
                            disableSelect: true
                        })
                    });
                } catch (err) {
                    if (!isExpiredInteractionError(err)) {
                        logger.error(`[Commentary Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Commentary Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ ${error.message || 'An unexpected error occurred while loading commentary.'}`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Commentary Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    },
};
