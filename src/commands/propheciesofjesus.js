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

const PROPHECIES_PER_PAGE = 5;
const MAX_DESCRIPTION_CHARS = 350;

// Parses refs like "Isaiah 7:14", "Matthew 1:23", "Genesis 22:1-14", "2 Samuel 7:12".
// If the source field contains multiple refs (e.g., "Psalm 22:1; Matt 27:46"),
// takes the first. Returns null if unparseable.
function parseVerseRef(refStr) {
    if (!refStr) return null;
    const firstChunk = refStr.split(/[;,]/)[0].trim();
    const match = firstChunk.match(/^([1-3]?\s*[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+):(\d+)(?:-(\d+))?$/);
    if (!match) return null;
    const bookId = getBookId(match[1].trim());
    if (!bookId) return null;
    const chapter = parseInt(match[2]);
    const startVerse = parseInt(match[3]);
    const endVerse = match[4] ? parseInt(match[4]) : startVerse;
    if (isNaN(chapter) || isNaN(startVerse)) return null;
    return { bookId, chapter, startVerse, endVerse };
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

function buildProphecyPage({ prophecies, pageIdx, totalPages, disableNav = false }) {
    const start = pageIdx * PROPHECIES_PER_PAGE;
    const pageProphecies = prophecies.slice(start, start + PROPHECIES_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📜 Prophecies Fulfilled in Jesus${pageInfo}`
        ));

    pageProphecies.forEach((p, localIdx) => {
        const globalIdx = start + localIdx;
        const otRef = p['OT Reference'];
        const ntRef = p['NT Fulfillment'];
        const description = p.Description || '';

        // OT Section — prophecy text + [Open OT] button
        const otParsed = parseVerseRef(otRef);
        const otText = `**📜 Prophecy (${otRef || 'OT ref missing'}):**\n${truncate(description, MAX_DESCRIPTION_CHARS)}`;
        const otSection = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(otText));

        if (otParsed) {
            otSection.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(buildOpenCustomId(otParsed, `ot${globalIdx}`))
                    .setLabel('Open OT')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            otSection.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`prophecy:noot:${globalIdx}`)
                    .setLabel('Open OT')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        }
        container.addSectionComponents(otSection);

        // NT Section — fulfillment + [Open NT] button (only if NT ref present)
        if (ntRef && ntRef !== 'N/A') {
            const ntParsed = parseVerseRef(ntRef);
            const ntSection = new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `✅ **Fulfillment (${ntRef})**`
                ));

            if (ntParsed) {
                ntSection.setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(buildOpenCustomId(ntParsed, `nt${globalIdx}`))
                        .setLabel('Open NT')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                );
            } else {
                ntSection.setButtonAccessory(
                    new ButtonBuilder()
                        .setCustomId(`prophecy:nont:${globalIdx}`)
                        .setLabel('Open NT')
                        .setEmoji({ name: '📖' })
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true)
                );
            }
            container.addSectionComponents(ntSection);
        }
    });

    const pageSuffix = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`${prophecies.length} prophecies total${pageSuffix}`)
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

        const totalPages = Math.ceil(prophecies.length / PROPHECIES_PER_PAGE);

        try {
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildProphecyPage({ prophecies, pageIdx: 0, totalPages })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[PropheciesOfJesus Command]',
                render: (pageIdx, { disableNav }) =>
                    buildProphecyPage({ prophecies, pageIdx, totalPages, disableNav })
            });
        } catch (error) {
            logger.error(`[PropheciesOfJesus Command] Unhandled error: ${error.message}`, error.stack);
        }
    }
};
