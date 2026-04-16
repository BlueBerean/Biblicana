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
import { bibleWrapper, getBookId, numbersToBook } from '../utils/bibleHelper.js';
import { categoriesWrapper } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import { attachPageCollector, buildPageNavRow } from '../utils/paginationHelper.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const VERSES_PER_PAGE = 8;
const TOPICS_PER_PAGE = 24;
const MAX_VERSE_PREVIEW_LENGTH = 260;
const MAX_FETCH_REFS = 200;

// Original 97 topics exposed by RapidAPI's GetTopics; shown on `showall:true`
// to preserve historical UX. The new categories.sqlite has 7,000+ additional
// granular categories reachable by direct `topic:` search.
const CLASSICAL_97_TOPICS = [
    "addiction", "adultery", "afterlife", "alcohol", "angels", "anger", "animals", "anxiety",
    "baptism", "birth", "business", "charity", "children", "church", "compassion", "courage",
    "dating", "death", "deliverance", "depression", "devil", "discipleship", "divorce", "drugs",
    "endurance", "eternal life", "evil", "faith", "faithfulness", "family", "fasting", "fear",
    "food", "forgiveness", "friendship", "generosity", "good", "gospel", "gossip", "government",
    "grace", "gratitude", "guidance", "healing", "health", "holiness", "homosexuality", "hope",
    "humility", "idolatry", "ignorance", "integrity", "jealousy", "joy", "justice", "kindness",
    "kingdom of god", "life", "love", "marriage", "medicine", "miracles", "money", "obedience",
    "patience", "peace", "perseverance", "politics", "praise", "prayer", "predestination", "prophecy",
    "purpose", "racism", "redemption", "renewal", "repentance", "resurrection", "righteousness", "sacrifice",
    "salvation", "satan", "science", "second coming", "servanthood", "sex", "stress", "suffering",
    "suicide", "temptation", "trust", "truth", "unity", "wealth", "wisdom", "worrying",
    "worship"
];

function buildShowAllPage({ topics, moreCount, pageIdx, totalPages, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';
    const start = pageIdx * TOPICS_PER_PAGE;
    const pageTopics = topics.slice(start, start + TOPICS_PER_PAGE);

    // Bullet list, 2 columns via markdown list formatting
    const body = pageTopics.map(t => `• ${t}`).join('\n');
    const tailSuffix = (pageIdx === totalPages - 1 && moreCount > 0)
        ? `\n\n**+${moreCount.toLocaleString()} More topics** — use \`/topicalindex topic:<name>\` to search any of them`
        : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📚 Available Bible Topics${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`*Use \`/topicalindex topic:<name>\` to see verses for any of these topics.*`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body + tailSuffix))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`Showing ${pageTopics.length} of ${topics.length} classical topics${totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : ''}`)
        ));

    const components = [container];
    if (totalPages > 1) components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    return components;
}

function buildTopicSearchPage({ topic, rawTopic, pageEntries, pageIdx, totalPages, totalVerseCount, translation, disableNav = false }) {
    const pageInfo = totalPages > 1 ? ` · Page ${pageIdx + 1}/${totalPages}` : '';

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📖 Verses about "${rawTopic}"${pageInfo}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `*Tap any verse to open the full passage.*\n**Total references:** ${totalVerseCount}`
        ));

    pageEntries.forEach((entry, localIdx) => {
        if (!entry) return;
        const globalIdx = localIdx; // unique within this page render — suffices for Discord uniqueness
        const section = new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${entry.citation}** — ${entry.text}`));

        if (entry.bookId && entry.startVerse) {
            const customId = `openverse:bible:${entry.bookId}:${entry.chapter}:${entry.startVerse}:${entry.endVerse}:${globalIdx}`;
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(customId)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
            );
        } else {
            // Unresolvable ref (e.g. cross-book range) — keep Section visible with disabled button.
            section.setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`topicalindex:noop:${globalIdx}`)
                    .setLabel('Open')
                    .setEmoji({ name: '📖' })
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true)
            );
        }
        container.addSectionComponents(section);
    });

    const pageSuffix = totalPages > 1 ? ` | Page ${pageIdx + 1}/${totalPages}` : '';
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine(`Translation: ${translation.toUpperCase()}${pageSuffix}`)
    ));

    const components = [container];
    if (totalPages > 1) components.push(buildPageNavRow({ pageIdx, totalPages, disabled: disableNav }));
    return components;
}

async function resolveVerseEntries(refs, translation) {
    const promises = refs.slice(0, MAX_FETCH_REFS).map(async ref => {
        const bookId = getBookId(ref.book);
        const bookName = bookId ? numbersToBook.get(bookId) : null;
        if (!bookId || !bookName) return null;

        const chapter = parseInt(ref.chapter);
        const startVerse = ref.verse != null ? parseInt(ref.verse) : parseInt(ref.start_verse);
        const endVerseRaw = ref.end_verse != null ? parseInt(ref.end_verse) : startVerse;

        if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerseRaw)) return null;

        const citation = endVerseRaw > startVerse
            ? `${bookName} ${chapter}:${startVerse}-${endVerseRaw}`
            : `${bookName} ${chapter}:${startVerse}`;

        try {
            const versesData = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerseRaw);
            if (!versesData || versesData.length === 0) {
                return { citation, text: '(verse text unavailable)', bookId, chapter, startVerse, endVerse: endVerseRaw };
            }
            const verseText = versesData.map(v => v[translation] || v.BSB || v.KJV || '').filter(Boolean).join(' ');
            const truncated = verseText.length > MAX_VERSE_PREVIEW_LENGTH
                ? verseText.substring(0, MAX_VERSE_PREVIEW_LENGTH - 1) + '…'
                : verseText || '(text unavailable)';
            return { citation, text: truncated, bookId, chapter, startVerse, endVerse: endVerseRaw };
        } catch (err) {
            return { citation, text: '(error fetching)', bookId, chapter, startVerse, endVerse: endVerseRaw };
        }
    });
    const results = await Promise.allSettled(promises);
    return results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

export default {
    data: new SlashCommandBuilder()
        .setName('topicalindex')
        .setDescription('Search the Bible by topic or view all topics')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('The topic to search for (e.g., faith, love, hope)')
                .setRequired(false)
                .setMinLength(3)
                .setMaxLength(100))
        .addBooleanOption(option =>
            option.setName('showall')
                .setDescription('Show all available topics instead of searching')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Verse translation (defaults to your preference or BSB)')
                .setRequired(false)
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        const rawTopic = interaction.options.getString('topic');
        const topic = rawTopic ? swearWordFilter(rawTopic.trim().toLowerCase()) : null;
        const showAll = interaction.options.getBoolean('showall') ?? false;

        if (!topic && !showAll) {
            return interaction.reply({
                content: 'Please provide a topic to search for, or set `showall` to true to list all topics.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            // --- showall mode ---
            if (showAll) {
                logger.info('[TopicalIndex Command] Listing all topics.');
                const totalCategories = await categoriesWrapper.totalCategoryCount();
                const moreCount = Math.max(0, totalCategories - CLASSICAL_97_TOPICS.length);
                const topics = [...CLASSICAL_97_TOPICS].sort();
                const totalPages = Math.ceil(topics.length / TOPICS_PER_PAGE);

                const message = await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildShowAllPage({ topics, moreCount, pageIdx: 0, totalPages })
                });

                if (totalPages <= 1) return;

                attachPageCollector({
                    interaction, message, totalPages,
                    logLabel: '[TopicalIndex Command ShowAll]',
                    render: (pageIdx, { disableNav }) =>
                        buildShowAllPage({ topics, moreCount, pageIdx, totalPages, disableNav })
                });
                return;
            }

            // --- topic-search mode ---
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[TopicalIndex Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            logger.info(`[TopicalIndex Command] Searching topic: "${topic}" in ${translation}`);

            const refs = await categoriesWrapper.getRefsForTopic(topic);
            if (!refs || refs.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Topic "${topic}" not found. Use \`/topicalindex showall:true\` to see available topics.`
                    )]
                });
            }

            logger.info(`[TopicalIndex Command] Found ${refs.length} refs for "${topic}"`);
            const entries = await resolveVerseEntries(refs, translation);

            if (entries.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Found ${refs.length} references for "${topic}" but couldn't retrieve any verse text.`
                    )]
                });
            }

            const totalPages = Math.ceil(entries.length / VERSES_PER_PAGE);
            const pageEntries = (idx) => entries.slice(idx * VERSES_PER_PAGE, idx * VERSES_PER_PAGE + VERSES_PER_PAGE);

            const message = await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildTopicSearchPage({
                    topic, rawTopic, pageEntries: pageEntries(0),
                    pageIdx: 0, totalPages, totalVerseCount: refs.length, translation
                })
            });

            if (totalPages <= 1) return;

            attachPageCollector({
                interaction, message, totalPages,
                logLabel: '[TopicalIndex Command]',
                render: (pageIdx, { disableNav }) =>
                    buildTopicSearchPage({
                        topic, rawTopic, pageEntries: pageEntries(pageIdx),
                        pageIdx, totalPages, totalVerseCount: refs.length, translation, disableNav
                    })
            });
        } catch (error) {
            logger.error(`[TopicalIndex Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, there was an unexpected error.`)]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[TopicalIndex Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
