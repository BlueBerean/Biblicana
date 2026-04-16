import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { fathersWrapper, toCommentaryBookVariants } from '../utils/studyHelper.js';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter, { escapeMarkdown } from '../utils/filter.js';
import 'dotenv/config';

const MAX_TEXT_LENGTH = 3500;
const FATHERS_PER_LIST_PAGE = 30;

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

function buildFatherPage({ entry, bookId, bookName, chapter, verse, pageIdx, totalPages, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const headerLines = [`## 📜 ${entry.father_name} on ${bookName} ${chapter}:${verse}${pageInfo}`];
    if (entry.default_year) {
        headerLines.push(`*c. ${entry.default_year}*`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            truncate(entry.txt || '*No commentary text available.*', MAX_TEXT_LENGTH)
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`${entry.father_name}${totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : ''}`)
        ));

    const components = [container];

    // Row 1 — in-app actions (Secondary style, customId-routed)
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:bible:${bookId}:${chapter}:${verse}`)
            .setLabel('Open passage')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary)
    ));

    // Row 2 — external links (Link style)
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

    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    }
    return components;
}

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
            const bookVariants = toCommentaryBookVariants(canonicalBookName);
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

            logger.info(`[Fathers Command] Found ${results.length} entries`);

            const totalPages = results.length;
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildFatherPage({
                    entry: results[0],
                    bookId, bookName: canonicalBookName, chapter, verse,
                    pageIdx: 0, totalPages
                })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Fathers Command]',
                render: (pageIdx, { disableNav }) =>
                    buildFatherPage({
                        entry: results[pageIdx],
                        bookId, bookName: canonicalBookName, chapter, verse,
                        pageIdx, totalPages, disableNav
                    })
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
