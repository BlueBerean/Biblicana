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
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import swearWordFilter from '../utils/filter.js';
import { numbersToBook } from '../utils/bibleHelper.js';
import { commentaryWrapper, fromCommentaryBookCode } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 3500;

// Returns { label, bookId, chapter, startVerse, endVerse, isMultiChapter } — or null.
// isMultiChapter flags spans like Gen 11:26 – 25:11 that can't be cleanly opened
// via /bible (single-chapter only). Caller disables the Open button for those.
function resolveScriptureRef(p) {
    const bookId = fromCommentaryBookCode(p.referenceBook);
    const bookName = bookId ? numbersToBook.get(bookId) : p.referenceBook;
    if (!bookName) return null;

    const chapter = p.referenceChapter;
    const verse = p.referenceVerse;
    const endChapter = p.referenceEndChapter;
    const endVerse = p.referenceEndVerse;

    if (!chapter) return { label: bookName, bookId: null, chapter: null, startVerse: null, endVerse: null, isMultiChapter: false };

    const isMultiChapter = !!(endChapter && endChapter !== chapter);

    let label;
    if (isMultiChapter) {
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
        startVerse: openable ? verse : null,
        endVerse: openable ? (endVerse && !isMultiChapter ? endVerse : verse) : null,
        isMultiChapter
    };
}

function buildProfilePage({ page, pageIdx, totalPages, matchType, rawTopic, disableNav = false }) {
    const { profile, chunk, chunkIdx, totalChunksForProfile } = page;

    const titleBase = matchType === 'fuzzy'
        ? `Profile: ${profile.subject} (match for "${rawTopic}")`
        : `Profile: ${profile.subject}`;
    const chunkSuffix = totalChunksForProfile > 1
        ? ` (${chunkIdx + 1}/${totalChunksForProfile})`
        : '';
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📚 ${titleBase}${chunkSuffix}${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));

    // Primary Reference — only on the first chunk of each profile, to avoid repetition.
    if (chunkIdx === 0) {
        const ref = resolveScriptureRef(profile);
        if (ref) {
            if (ref.bookId && ref.chapter && ref.startVerse) {
                // Resolvable to a verse. Button is enabled for single-chapter refs,
                // disabled for multi-chapter spans (can't open cleanly via /bible).
                const button = new ButtonBuilder()
                    .setCustomId(ref.isMultiChapter
                        ? `profile:noopen:multichapter`
                        : `openverse:bible:${ref.bookId}:${ref.chapter}:${ref.startVerse}:${ref.endVerse}`)
                    .setLabel('Open passage')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(ref.isMultiChapter);

                container.addSectionComponents(
                    new SectionBuilder()
                        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📖 Primary Reference:** ${ref.label}`))
                        .setButtonAccessory(button)
                );
            } else {
                // Book-only or ambiguous — just show the reference as text
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**📖 Primary Reference:** ${ref.label}`));
            }
        }
    }

    const commentaryLabel = profile.commentaryName || 'Tyndale Open Study Notes';
    const pageSuffix = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`${commentaryLabel}${pageSuffix}`)
    ));

    const components = [container];
    if (totalPages > 1) {
        components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
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
            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildProfilePage({ page: pages[0], pageIdx: 0, totalPages, matchType, rawTopic })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[Profile Command]',
                render: (pageIdx, { disableNav }) =>
                    buildProfilePage({ page: pages[pageIdx], pageIdx, totalPages, matchType, rawTopic, disableNav })
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
