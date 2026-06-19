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
import { fathersWrapper, pickMarqueeFather } from '../utils/studyHelper.js';
import { getBookId, numbersToBook, toCommentaryVariants } from '../utils/bookNames.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow, isExpiredInteractionError } from '../utils/paginationHelper.js';
import splitString from '../utils/splitString.js';
import logger from '../utils/logger.js';
import swearWordFilter, { escapeMarkdown } from '../utils/filter.js';
import 'dotenv/config';

const MAX_TEXT_LENGTH = 3500;
const FATHERS_PER_LIST_PAGE = 30;
const FATHERS_DROPDOWN_CAP = 25;          // Discord select-menu hard cap
const COLLECTOR_TIMEOUT_MS = 1_800_000;   // 30 min

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

// ---- List mode (directory of all 334 Fathers, unchanged) -------------------

function buildFathersListPage({ fathers, pageIdx, totalPages, disableNav = false }) {
    const start = pageIdx * FATHERS_PER_LIST_PAGE;
    const pageFathers = fathers.slice(start, start + FATHERS_PER_LIST_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const lines = pageFathers.map(f => {
        const year = f.year ? `c. ${f.year}` : 'undated';
        const count = f.entry_count === 1 ? '1 entry' : `${f.entry_count} entries`;
        return `• **${f.name}** — *${year}* · ${count}`;
    });

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📜 Early Church Fathers${pageInfo}`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `*${fathers.length} fathers available. Use \`/fathers book:<name> chapter:<#> verse:<#> father:<name>\` to filter by any of these.*`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`${fathers.length} fathers total${pageInfo}`)
        ));

    const components = [container];
    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

// ---- Passage mode (dropdown per Father + nav within each Father's entries) -

function groupByFather(rows) {
    const byName = new Map();
    for (const r of rows) {
        if (!byName.has(r.father_name)) byName.set(r.father_name, []);
        byName.get(r.father_name).push(r);
    }
    return byName;
}

// Flatten a Father's entries into a single ordered page list so Previous/Next
// walks pages linearly across entries. Each page carries back-pointers to its
// entry + position so the header/links know the current entry context.
function buildFatherPages(fatherRows, maxChars) {
    const pages = [];
    fatherRows.forEach((entry, entryIdx) => {
        const chunks = splitString(entry.txt || '*No commentary text available.*', maxChars);
        chunks.forEach((text, pageInEntryIdx) => {
            pages.push({
                entry,
                entryIdx,
                pageInEntryIdx,
                pagesInEntry: chunks.length,
                text,
            });
        });
    });
    return pages;
}

export default {
    data: new SlashCommandBuilder()
        .setName('fathers')
        .setDescription('Search Early Church Fathers\' commentary (or list all with list:true)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addBooleanOption(option =>
            option.setName('list')
                .setDescription('List all 334 Church Fathers available to search (ignores other options)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Bible book (e.g., John, Genesis, 1 Corinthians)')
                .setRequired(false)
                .setMaxLength(50))
        .addIntegerOption(option =>
            option.setName('chapter')
                .setDescription('Chapter number')
                .setRequired(false)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('verse')
                .setDescription('Verse number')
                .setRequired(false)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('father')
                .setDescription('Filter to a specific Church Father (e.g., Augustine, Chrysostom)')
                .setRequired(false)
                .setMaxLength(100)),

    async execute(interaction) {
        const listMode = interaction.options.getBoolean('list') === true;

        if (listMode) {
            await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });
            try {
                logger.info(`[Fathers Command] Listing all fathers`);
                const fathers = await fathersWrapper.listAllFathers();
                if (!fathers || fathers.length === 0) {
                    return interaction.editReply({
                        flags: MessageFlags.IsComponentsV2,
                        components: [new TextDisplayBuilder().setContent(`❌ No fathers data available.`)]
                    });
                }
                const totalPages = Math.ceil(fathers.length / FATHERS_PER_LIST_PAGE);
                const message = await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildFathersListPage({ fathers, pageIdx: 0, totalPages })
                });
                if (totalPages <= 1) return;
                return attachPageCollector({
                    interaction, message, totalPages,
                    logLabel: '[Fathers Command]',
                    render: (pageIdx, { disableNav }) =>
                        buildFathersListPage({ fathers, pageIdx, totalPages, disableNav })
                });
            } catch (err) {
                logger.error(`[Fathers Command] List error: ${err.message}`);
                try {
                    await interaction.editReply({
                        flags: MessageFlags.IsComponentsV2,
                        components: [new TextDisplayBuilder().setContent(`❌ Couldn't load fathers directory.`)]
                    });
                } catch (_) { /* ignore */ }
                return;
            }
        }

        // Passage-lookup mode requires book + chapter + verse.
        const rawBookInput = interaction.options.getString('book');
        const chapter = interaction.options.getInteger('chapter');
        const verse = interaction.options.getInteger('verse');
        const fatherFilter = interaction.options.getString('father')?.trim() || null;

        if (!rawBookInput || chapter === null || verse === null) {
            return interaction.reply({
                content: `Please provide **book**, **chapter**, and **verse** — or use \`list:True\` to see all available fathers.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const rawBook = swearWordFilter(rawBookInput.trim());
        const bookId = getBookId(rawBook);
        const canonicalBookName = bookId ? numbersToBook.get(bookId) : null;
        if (!bookId || !canonicalBookName) {
            return interaction.reply({
                content: `❌ Unknown book: "${rawBook}". Try "John", "Genesis", "1 Corinthians", etc.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const bookVariants = toCommentaryVariants(canonicalBookName);
            logger.info(`[Fathers Command] Query: ${canonicalBookName} ${chapter}:${verse}${fatherFilter ? ' by ' + fatherFilter : ''}`);

            const results = await fathersWrapper.getByPassage(bookVariants, chapter, verse, fatherFilter);
            if (!results || results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No commentary found for **${canonicalBookName} ${chapter}:${verse}**${fatherFilter ? ' from fathers matching "' + escapeMarkdown(fatherFilter) + '"' : ''}. Some books (especially minor prophets) have sparse coverage.`
                    )]
                });
            }
            logger.info(`[Fathers Command] Found ${results.length} entries across ${new Set(results.map(r => r.father_name)).size} fathers`);

            // Group and order Fathers: marquee-first when unfiltered, otherwise
            // preserve the SQL's alphabetical order (the filter is usually
            // user-scoped to a single Father, so ordering doesn't matter then).
            const byName = groupByFather(results);
            const orderedNames = [...byName.keys()];
            const leadName = pickMarqueeFather(results);
            if (leadName && !fatherFilter) {
                const idx = orderedNames.indexOf(leadName);
                if (idx > 0) { orderedNames.splice(idx, 1); orderedNames.unshift(leadName); }
            }
            const cappedNames = orderedNames.slice(0, FATHERS_DROPDOWN_CAP);
            const truncatedFathers = orderedNames.length > FATHERS_DROPDOWN_CAP;

            // State (inside closure for the collector). pageIdx is the flat
            // index into the currently-selected Father's page list (which
            // spans all their entries' pages). Switching Father resets to 0.
            let selectedName = cappedNames[0];
            let pageIdx = 0;

            // Cache paginated pages per Father so Prev/Next is instant and
            // we don't re-split on every click.
            const pagesCache = new Map();
            const pagesFor = (name) => {
                if (!pagesCache.has(name)) {
                    pagesCache.set(name, buildFatherPages(byName.get(name) ?? [], MAX_TEXT_LENGTH));
                }
                return pagesCache.get(name);
            };

            const renderView = ({ disabled = false } = {}) => {
                const pages = pagesFor(selectedName);
                const clampedIdx = Math.max(0, Math.min(pageIdx, pages.length - 1));
                const current = pages[clampedIdx];
                const entry = current.entry;
                const entryCount = (byName.get(selectedName) ?? []).length;

                // Header suffix carries both counters when they add information.
                let suffix = '';
                if (entryCount > 1) suffix += ` · entry ${current.entryIdx + 1}/${entryCount}`;
                if (current.pagesInEntry > 1) suffix += ` · page ${current.pageInEntryIdx + 1}/${current.pagesInEntry}`;

                const yearLine = entry.default_year ? `*c. ${entry.default_year}*\n` : '';
                const truncNote = truncatedFathers
                    ? `\n-# Showing top ${FATHERS_DROPDOWN_CAP} of ${orderedNames.length} Fathers. Refine with \`father:<name>\`.`
                    : '';

                const container = new ContainerBuilder()
                    .setAccentColor(accentColor())
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                        `## 📜 ${selectedName} on ${canonicalBookName} ${chapter}:${verse}${suffix}`
                    ))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                        yearLine + current.text + truncNote
                    ))
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                        footerLine(entry.source_title
                            ? `${selectedName} · ${entry.source_title}`
                            : selectedName)
                    ));

                const components = [container];

                // Row 1: Open passage (always visible — it's the most useful action)
                components.push(new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`openverse:bible:${bookId}:${chapter}:${verse}`)
                        .setLabel('Open passage')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(disabled)
                ));

                // Row 2: external links for THIS entry (source + wikipedia).
                // Change as pageIdx crosses entry boundaries.
                const linkButtons = [];
                if (entry.source_url) {
                    linkButtons.push(new ButtonBuilder()
                        .setLabel(entry.source_title ? truncate(entry.source_title, 80) : 'Source')
                        .setEmoji({ name: '🔗' })
                        .setStyle(ButtonStyle.Link)
                        .setURL(entry.source_url));
                }
                if (entry.wiki_url) {
                    linkButtons.push(new ButtonBuilder()
                        .setLabel('Wikipedia')
                        .setEmoji({ name: '📚' })
                        .setStyle(ButtonStyle.Link)
                        .setURL(entry.wiki_url));
                }
                if (linkButtons.length > 0) {
                    components.push(new ActionRowBuilder().addComponents(...linkButtons));
                }

                // Row 3: Prev/Next — flat over ALL pages of this Father's
                // entries. Labels stay "Previous / Next" (generic) since each
                // click can mean either a page step or an entry step.
                if (pages.length > 1) {
                    components.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('fathers_prev')
                            .setLabel('Previous')
                            .setEmoji({ name: '◀️' })
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(disabled || clampedIdx === 0),
                        new ButtonBuilder()
                            .setCustomId('fathers_next')
                            .setLabel('Next')
                            .setEmoji({ name: '▶️' })
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(disabled || clampedIdx === pages.length - 1),
                    ));
                }

                // Row 4: Switch-Father select (only when >1 Father available)
                if (cappedNames.length > 1) {
                    components.push(new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                            .setCustomId('fathers_select')
                            .setPlaceholder('Switch Father')
                            .setDisabled(disabled)
                            .addOptions(cappedNames.map(name => {
                                const count = byName.get(name).length;
                                return {
                                    label: name.slice(0, 100),
                                    value: name.slice(0, 100),
                                    description: count > 1 ? `${count} entries on this verse` : undefined,
                                    default: name === selectedName,
                                };
                            }))
                    ));
                }

                return components;
            };

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: renderView(),
            });

            // Nothing to collect against — single Father with a single page.
            const hasMultiFathers = cappedNames.length > 1;
            const hasAnyMultiPage = cappedNames.some(name => pagesFor(name).length > 1);
            if (!hasMultiFathers && !hasAnyMultiPage) return;

            const filter = i => i.user.id === interaction.user.id
                && (i.customId === 'fathers_select' || i.customId === 'fathers_prev' || i.customId === 'fathers_next');
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'fathers_select') {
                        const picked = i.values[0];
                        if (byName.has(picked)) {
                            selectedName = picked;
                            pageIdx = 0;
                        }
                    } else if (i.customId === 'fathers_prev') {
                        pageIdx = Math.max(0, pageIdx - 1);
                    } else if (i.customId === 'fathers_next') {
                        const max = pagesFor(selectedName).length - 1;
                        pageIdx = Math.min(max, pageIdx + 1);
                    }
                    await i.editReply({
                        flags: MessageFlags.IsComponentsV2,
                        components: renderView(),
                    });
                } catch (err) {
                    logger.error(`[Fathers Command] Collector error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags: MessageFlags.IsComponentsV2,
                        components: renderView({ disabled: true }),
                    });
                } catch (err) {
                    if (!isExpiredInteractionError(err)) {
                        logger.error(`[Fathers Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Fathers Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, an unexpected error occurred.`)]
                });
            } catch (replyError) {
                logger.error(`[Fathers Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
