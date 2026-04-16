import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../utils/logger.js';
import { getBookId } from '../utils/bibleHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Hard cap on Sections per page. Each Section with a button costs ~3 toward
// Discord's 40-component tree cap; overhead (container + header + footer +
// nav row + 2 nav buttons) eats ~6, so ~11 sections per page is the safe max.
// We pack 9 to leave room for edge cases.
const MAX_SECTIONS_PER_PAGE = 9;
const MAX_REFS_PER_FIELD = 3;  // Cap wild multi-ref strings to keep per-prophecy section count bounded
const MAX_DESCRIPTION_CHARS = 350;

// Parse ONE ref chunk like "Isaiah 7:14" or "Genesis 22:1-14". Returns null if unparseable.
function parseSingleRef(chunk) {
    const match = chunk.trim().match(/^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+):(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const bookId = getBookId(match[1].trim());
    if (!bookId) return null;
    const chapter = parseInt(match[2]);
    const startVerse = parseInt(match[3]);
    const endVerse = match[4] ? parseInt(match[4]) : startVerse;
    if (isNaN(chapter) || isNaN(startVerse)) return null;
    return { bookId, chapter, startVerse, endVerse, label: chunk.trim() };
}

// Parse a refs field that may contain multiple refs separated by ; or ,
// (e.g., "Gal 4:4-5; Matt 1:18"). Returns an array of parsed refs, skipping
// any unparseable chunks. Capped at MAX_REFS_PER_FIELD so pathologically
// long fields can't blow the 40-component page budget.
function parseAllVerseRefs(refStr) {
    if (!refStr) return [];
    return refStr.split(/[;,]/)
        .map(chunk => parseSingleRef(chunk))
        .filter(Boolean)
        .slice(0, MAX_REFS_PER_FIELD);
}

// How many Sections a prophecy will occupy on a page — one per OT ref (or 1
// fallback if none parse) plus one per NT ref when the NT field is present.
function sectionsFor(p) {
    const otCount = parseAllVerseRefs(p['OT Reference']).length || 1;
    const hasNt = p['NT Fulfillment'] && p['NT Fulfillment'] !== 'N/A';
    const ntCount = hasNt ? (parseAllVerseRefs(p['NT Fulfillment']).length || 1) : 0;
    return otCount + ntCount;
}

// Greedy packer: each page fills up to MAX_SECTIONS_PER_PAGE sections, then
// spills into the next. Produces pages of varying prophecy-counts depending
// on how dense each prophecy's reference set is.
function packPages(prophecies) {
    const pages = [];
    let current = [];
    let currentSections = 0;
    prophecies.forEach((p, globalIdx) => {
        const needed = sectionsFor(p);
        if (current.length > 0 && currentSections + needed > MAX_SECTIONS_PER_PAGE) {
            pages.push(current);
            current = [];
            currentSections = 0;
        }
        current.push({ prophecy: p, globalIdx });
        currentSections += needed;
    });
    if (current.length > 0) pages.push(current);
    return pages;
}

function truncate(text, max) {
    if (!text) return '';
    return text.length > max ? text.substring(0, max - 1) + '…' : text;
}

function buildOpenCustomId(ref, uniqueSuffix) {
    // Always include endVerse + a uniqueness suffix as parts 6 and 7 so that
    // prophecies referencing the same verse (common for Isaiah 53, Psalm 22,
    // etc.) produce distinct customIds per row. Router ignores the 7th part.
    return `openverse:bible:${ref.bookId}:${ref.chapter}:${ref.startVerse}:${ref.endVerse}:${uniqueSuffix}`;
}

function buildProphecyPage({ pages, totalProphecyCount, pageIdx, totalPages, disableNav = false }) {
    const pageItems = pages[pageIdx];
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📜 Prophecies Fulfilled in Jesus${pageInfo}`
        ));

    pageItems.forEach(({ prophecy: p, globalIdx }) => {
        const otRef = p['OT Reference'];
        const ntRef = p['NT Fulfillment'];
        const description = p.Description || '';

        // OT — one Section per parsed ref. First Section carries the prophecy
        // description; subsequent Sections (for multi-ref fields) just label
        // the additional ref. If nothing parses, fall back to a disabled button.
        const otRefs = parseAllVerseRefs(otRef);
        if (otRefs.length > 0) {
            otRefs.forEach((parsed, refIdx) => {
                const firstChunk = refIdx === 0
                    ? `**📜 Prophecy (${parsed.label}):**\n${truncate(description, MAX_DESCRIPTION_CHARS)}`
                    : `**📜 Prophecy (${parsed.label})**`;
                container.addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(firstChunk))
                        .setButtonAccessory(
                            new ButtonBuilder()
                                .setCustomId(buildOpenCustomId(parsed, `ot${globalIdx}-${refIdx}`))
                                .setLabel('Open OT')
                                .setEmoji({ name: '📖' })
                                .setStyle(ButtonStyle.Secondary)
                        )
                );
            });
        } else {
            const otText = `**📜 Prophecy (${otRef || 'OT ref missing'}):**\n${truncate(description, MAX_DESCRIPTION_CHARS)}`;
            container.addSectionComponents(
                new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(otText))
                    .setButtonAccessory(
                        new ButtonBuilder()
                            .setCustomId(`prophecy:noot:${globalIdx}`)
                            .setLabel('Open OT')
                            .setEmoji({ name: '📖' })
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(true)
                    )
            );
        }

        // NT — one Section per parsed ref. Fulfillment fields commonly contain
        // multiple refs like "Gal 4:4-5; Matt 1:18"; each gets its own Open button.
        if (ntRef && ntRef !== 'N/A') {
            const ntRefs = parseAllVerseRefs(ntRef);
            if (ntRefs.length > 0) {
                ntRefs.forEach((parsed, refIdx) => {
                    container.addSectionComponents(
                        new SectionBuilder()
                            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                                `✅ **Fulfillment (${parsed.label})**`
                            ))
                            .setButtonAccessory(
                                new ButtonBuilder()
                                    .setCustomId(buildOpenCustomId(parsed, `nt${globalIdx}-${refIdx}`))
                                    .setLabel('Open NT')
                                    .setEmoji({ name: '📖' })
                                    .setStyle(ButtonStyle.Secondary)
                            )
                    );
                });
            } else {
                container.addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                            `✅ **Fulfillment (${ntRef})**`
                        ))
                        .setButtonAccessory(
                            new ButtonBuilder()
                                .setCustomId(`prophecy:nont:${globalIdx}`)
                                .setLabel('Open NT')
                                .setEmoji({ name: '📖' })
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true)
                        )
                );
            }
        }
    });

    const pageSuffix = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`${totalProphecyCount} prophecies total${pageSuffix}`)
    ));

    const components = [container];

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

export default {
    data: new SlashCommandBuilder()
        .setName('propheciesofjesus')
        .setDescription('Displays prophecies about Jesus fulfilled in Scripture (paginated).')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        let prophecies = [];
        try {
            const filePath = path.join(__dirname, '..', '..', 'data', 'prophecies.json');
            logger.info(`[PropheciesOfJesus Command] Reading: ${filePath}`);
            prophecies = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (!Array.isArray(prophecies)) throw new Error('Prophecies data is not an array.');
            logger.info(`[PropheciesOfJesus Command] Loaded ${prophecies.length} prophecies.`);
        } catch (error) {
            logger.error(`[PropheciesOfJesus Command] Load error: ${error.message}`);
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [new TextDisplayBuilder().setContent(
                    `❌ Couldn't load the prophecy data file.`
                )]
            });
        }

        if (prophecies.length === 0) {
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [new TextDisplayBuilder().setContent(`❌ No prophecies in the data file.`)]
            });
        }

        const pages = packPages(prophecies);
        const totalPages = pages.length;
        const totalProphecyCount = prophecies.length;
        logger.info(`[PropheciesOfJesus Command] Packed ${totalProphecyCount} prophecies into ${totalPages} pages`);

        try {
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildProphecyPage({ pages, totalProphecyCount, pageIdx: 0, totalPages })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[PropheciesOfJesus Command]',
                render: (pageIdx, { disableNav }) =>
                    buildProphecyPage({ pages, totalProphecyCount, pageIdx, totalPages, disableNav })
            });
        } catch (error) {
            logger.error(`[PropheciesOfJesus Command] Unhandled error: ${error.message}`, error.stack);
        }
    }
};
