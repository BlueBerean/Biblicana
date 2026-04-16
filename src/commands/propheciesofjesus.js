import {
    SlashCommandBuilder,
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
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
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROPHECIES_PER_PAGE = 5;
const PAGINATION_TIMEOUT_MS = 600_000;
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
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const start = pageIdx * PROPHECIES_PER_PAGE;
    const pageProphecies = prophecies.slice(start, start + PROPHECIES_PER_PAGE);
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
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

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${prophecies.length} prophecies total${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`
    ));

    const components = [container];

    if (totalPages > 1) {
        components.push(new ActionRowBuilder().addComponents(
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
        ));
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
        let pageIdx = 0;
        const flags = MessageFlags.IsComponentsV2;

        try {
            await interaction.editReply({
                flags,
                components: buildProphecyPage({ prophecies, pageIdx, totalPages })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: PAGINATION_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
                    else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
                    await i.editReply({
                        flags,
                        components: buildProphecyPage({ prophecies, pageIdx, totalPages })
                    });
                } catch (err) {
                    logger.error(`[PropheciesOfJesus Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildProphecyPage({ prophecies, pageIdx, totalPages, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[PropheciesOfJesus Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[PropheciesOfJesus Command] Unhandled error: ${error.message}`, error.stack);
        }
    }
};
