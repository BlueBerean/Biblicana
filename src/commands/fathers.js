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
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const MAX_TEXT_LENGTH = 3500;
const COLLECTOR_TIMEOUT_MS = 600_000;

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '…';
}

function buildFatherPage({ entry, bookId, bookName, chapter, verse, pageIdx, totalPages, disableNav = false }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
    const pageInfo = totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : '';

    const headerLines = [`## 📜 ${entry.father_name} on ${bookName} ${chapter}:${verse}${pageInfo}`];
    if (entry.default_year) {
        headerLines.push(`*c. ${entry.default_year}*`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            truncate(entry.txt || '*No commentary text available.*', MAX_TEXT_LENGTH)
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${entry.father_name}${totalPages > 1 ? ` · ${pageIdx + 1}/${totalPages}` : ''}`
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
        .setName('fathers')
        .setDescription('Search Early Church Fathers\' commentary on a biblical passage')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Bible book (e.g., John, Genesis, 1 Corinthians)')
                .setRequired(true)
                .setMaxLength(50))
        .addIntegerOption(option =>
            option.setName('chapter')
                .setDescription('Chapter number')
                .setRequired(true)
                .setMinValue(1))
        .addIntegerOption(option =>
            option.setName('verse')
                .setDescription('Verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('father')
                .setDescription('Filter to a specific Church Father (e.g., Augustine, Chrysostom)')
                .setRequired(false)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawBook = swearWordFilter(interaction.options.getString('book').trim());
        const chapter = interaction.options.getInteger('chapter');
        const verse = interaction.options.getInteger('verse');
        const fatherFilter = interaction.options.getString('father')?.trim() || null;

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
                        `❌ No commentary found for **${canonicalBookName} ${chapter}:${verse}**${fatherFilter ? ' from fathers matching "' + fatherFilter + '"' : ''}. Some books (especially minor prophets) have sparse coverage.`
                    )]
                });
            }

            logger.info(`[Fathers Command] Found ${results.length} entries`);

            let pageIdx = 0;
            const totalPages = results.length;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildFatherPage({
                    entry: results[pageIdx],
                    bookId, bookName: canonicalBookName, chapter, verse,
                    pageIdx, totalPages
                })
            });

            if (totalPages <= 1) return;

            const message = await interaction.fetchReply();
            const filter = i => i.user.id === interaction.user.id &&
                (i.customId === 'page_back' || i.customId === 'page_next');
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
                    else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
                    await i.editReply({
                        flags,
                        components: buildFatherPage({
                            entry: results[pageIdx],
                            bookId, bookName: canonicalBookName, chapter, verse,
                            pageIdx, totalPages
                        })
                    });
                } catch (err) {
                    logger.error(`[Fathers Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                try {
                    await interaction.editReply({
                        flags,
                        components: buildFatherPage({
                            entry: results[pageIdx],
                            bookId, bookName: canonicalBookName, chapter, verse,
                            pageIdx, totalPages, disableNav: true
                        })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
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
