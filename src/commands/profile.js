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
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import { numbersToBook } from '../utils/bibleHelper.js';
import { commentaryWrapper, fromCommentaryBookCode } from '../utils/studyHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 3500;
const COLLECTOR_TIMEOUT_MS = 600_000;

// Returns { label, bookId, chapter, verse } — or null if no usable reference.
// bookId/chapter/verse are populated only when resolvable enough for an openverse button.
function resolveScriptureRef(p) {
    const bookId = fromCommentaryBookCode(p.referenceBook);
    const bookName = bookId ? numbersToBook.get(bookId) : p.referenceBook;
    if (!bookName) return null;

    const chapter = p.referenceChapter;
    const verse = p.referenceVerse;
    const endChapter = p.referenceEndChapter;
    const endVerse = p.referenceEndVerse;

    if (!chapter) return { label: bookName, bookId: null, chapter: null, verse: null };

    let label;
    if (endChapter && endChapter !== chapter) {
        const endPart = endVerse ? `${endChapter}:${endVerse}` : `${endChapter}`;
        label = `${bookName} ${chapter}:${verse} – ${endPart}`;
    } else if (endVerse && endVerse !== verse) {
        label = `${bookName} ${chapter}:${verse}-${endVerse}`;
    } else {
        label = verse ? `${bookName} ${chapter}:${verse}` : `${bookName} ${chapter}`;
    }

    const openable = bookId && chapter && verse;
    return {
        label,
        bookId: openable ? bookId : null,
        chapter: openable ? chapter : null,
        verse: openable ? verse : null
    };
}

function buildProfilePage({ page, pageIdx, totalPages, matchType, rawTopic, disableNav = false }) {
    const { profile, chunk, chunkIdx, totalChunksForProfile } = page;
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;

    const titleBase = matchType === 'fuzzy'
        ? `Profile: ${profile.subject} (match for "${rawTopic}")`
        : `Profile: ${profile.subject}`;
    const chunkSuffix = totalChunksForProfile > 1
        ? ` (${chunkIdx + 1}/${totalChunksForProfile})`
        : '';
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📚 ${titleBase}${chunkSuffix}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));

    // Primary Reference — only on the first chunk of each profile, to avoid repetition.
    if (chunkIdx === 0) {
        const ref = resolveScriptureRef(profile);
        if (ref) {
            if (ref.bookId && ref.chapter && ref.verse) {
                // Resolvable to a specific verse → Section with [📖 Open passage] button
                const section = new SectionBuilder()
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📖 Primary Reference:** ${ref.label}`))
                    .setButtonAccessory(
                        new ButtonBuilder()
                            .setCustomId(`openverse:bible:${ref.bookId}:${ref.chapter}:${ref.verse}`)
                            .setLabel('Open passage')
                            .setEmoji({ name: '📖' })
                            .setStyle(ButtonStyle.Secondary)
                    );
                container.addSectionComponents(section);
            } else {
                // Book-only or ambiguous — just show the reference as text
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📖 Primary Reference:** ${ref.label}`));
            }
        }
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | ${profile.commentaryName || 'Tyndale Open Study Notes'}${pageInfo}`
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
        .setName('profile')
        .setDescription('Look up a biblical figure or topic in Tyndale Open Study Notes')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Subject to look up (e.g., Abraham, David, The Pharisees)')
                .setRequired(true)
                .setMinLength(2)
                .setMaxLength(100)),

    async execute(interaction) {
        const rawTopic = interaction.options.getString('topic').trim();
        const cleanTopic = swearWordFilter(rawTopic);
        if (!cleanTopic) {
            return interaction.reply({ content: 'Please provide a valid topic.', flags: MessageFlags.Ephemeral });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            logger.info(`[Profile Command] Searching: "${cleanTopic}"`);
            const { results, matchType } = await commentaryWrapper.searchProfiles(cleanTopic);

            if (!results || results.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No profile found for "${rawTopic}". Try names like Abraham, David, Mary, or groups like "The Pharisees".`
                    )]
                });
            }

            logger.info(`[Profile Command] Found ${results.length} profile(s), matchType=${matchType}`);

            const pages = [];
            for (const profile of results) {
                const chunks = splitString(profile.content || '(No content)', MAX_CHARS_PER_CHUNK);
                chunks.forEach((chunk, chunkIdx) => {
                    pages.push({ profile, chunk, chunkIdx, totalChunksForProfile: chunks.length });
                });
            }

            const totalPages = pages.length;
            let pageIdx = 0;
            const flags = MessageFlags.IsComponentsV2;

            await interaction.editReply({
                flags,
                components: buildProfilePage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawTopic })
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
                        components: buildProfilePage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawTopic })
                    });
                } catch (err) {
                    logger.error(`[Profile Command] Pagination error: ${err.message}`);
                }
            });

            collector.on('end', async () => {
                logger.info(`[Profile Command] Pagination collector ended for "${rawTopic}"`);
                try {
                    await interaction.editReply({
                        flags,
                        components: buildProfilePage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawTopic, disableNav: true })
                    });
                } catch (err) {
                    if (err.code !== 10008 && err.code !== 10062) {
                        logger.error(`[Profile Command] End error: ${err.message}`);
                    }
                }
            });
        } catch (error) {
            logger.error(`[Profile Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ An unexpected error occurred. Please try again later.`)]
                });
            } catch (replyError) {
                logger.error(`[Profile Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
