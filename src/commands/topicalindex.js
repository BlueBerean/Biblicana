import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../utils/logger.js';
import { bibleWrapper, getBookId, numbersToBook } from '../utils/bibleHelper.js';
import { categoriesWrapper } from '../utils/studyHelper.js';
import swearWordFilter from '../utils/filter.js';
import splitString from '../utils/splitString.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;
const ITEMS_PER_PAGE = 10;
const MAX_CHARS_PER_PAGE = 4000;
const MAX_VERSE_PREVIEW_LENGTH = 300;

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

function generateFooter(page = 0, maxPages = 1, translation = null, totalCount = null) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    const transText = translation ? ` | Translation: ${translation.toUpperCase()}` : '';
    const countText = totalCount !== null ? ` | Total Verses: ${totalCount}` : '';
    return {
        text: `${process.env.EMBEDFOOTERTEXT}${transText}${countText}${pageText}`,
        iconURL: process.env.EMBEDICONURL
    };
}

const createActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('◀️')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('▶️')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage >= totalPages - 1)
    );

async function formatVersesForPage(references, translation) {
    if (!references || references.length === 0) {
        return 'No verses for this page.';
    }

    const promises = references.map(async (ref) => {
        const bookId = getBookId(ref.book);
        const bookName = bookId ? numbersToBook.get(bookId) : null;
        if (!bookId || !bookName) {
            logger.warn(`[TopicalIndex Command] Unknown book "${ref.book}" — skipping`);
            return null;
        }

        const chapter = parseInt(ref.chapter);
        const startVerse = ref.verse != null ? parseInt(ref.verse) : parseInt(ref.start_verse);
        const endVerseRaw = ref.end_verse != null ? parseInt(ref.end_verse) : startVerse;

        if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerseRaw)) {
            logger.warn(`[TopicalIndex Command] Could not parse ref: ${JSON.stringify(ref)}`);
            return null;
        }

        const citation = endVerseRaw > startVerse
            ? `${bookName} ${chapter}:${startVerse}-${endVerseRaw}`
            : `${bookName} ${chapter}:${startVerse}`;

        try {
            const versesData = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerseRaw);
            if (!versesData || versesData.length === 0) {
                return `• **${citation}**: (verse text unavailable)`;
            }
            const verseText = versesData
                .map(v => v[translation] || v['BSB'] || v['KJV'] || '(Text unavailable)')
                .join(' ');
            const truncatedText = verseText.length > MAX_VERSE_PREVIEW_LENGTH
                ? verseText.substring(0, MAX_VERSE_PREVIEW_LENGTH - 3) + '...'
                : verseText;
            return `• **${citation}**: ${truncatedText}`;
        } catch (error) {
            logger.warn(`[TopicalIndex Command] Error fetching ${citation}: ${error.message}`);
            return `• **${citation}**: (error fetching text)`;
        }
    });

    const results = await Promise.allSettled(promises);
    return results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(Boolean)
        .join('\n\n');
}

export default {
    data: new SlashCommandBuilder()
        .setName('topicalindex')
        .setDescription('Search the Bible by topic or view all topics')
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
        await interaction.deferReply();

        try {
            const rawTopic = interaction.options.getString('topic');
            const topic = rawTopic ? swearWordFilter(rawTopic.trim().toLowerCase()) : null;
            const showAll = interaction.options.getBoolean('showall') ?? false;

            if (!topic && !showAll) {
                return interaction.editReply({
                    content: 'Please provide a topic to search for, or set `showall` to true to list all topics.',
                    ephemeral: true
                });
            }

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            if (showAll) {
                logger.info("[TopicalIndex Command] Requesting all topics.");

                try {
                    const totalCategories = await categoriesWrapper.totalCategoryCount();
                    const moreCount = Math.max(0, totalCategories - CLASSICAL_97_TOPICS.length);

                    const joined = [...CLASSICAL_97_TOPICS].sort().join(', \n');
                    const moreSuffix = moreCount > 0 ? `\n\n**+${moreCount.toLocaleString()} More**` : '';
                    const description = joined + moreSuffix;
                    const pages = splitString(description, MAX_CHARS_PER_PAGE);

                    if (pages.length === 0) {
                        return interaction.editReply({ content: 'Failed to format the topic list.', ephemeral: true });
                    }

                    let currentPageIndex = 0;
                    const embed = new EmbedBuilder()
                        .setTitle('📚 Available Bible Topics')
                        .setDescription(pages[currentPageIndex])
                        .setColor(embedColor)
                        .setURL(process.env.WEBSITE)
                        .setFooter(generateFooter(currentPageIndex, pages.length));

                    const message = await interaction.editReply({
                        embeds: [embed],
                        components: pages.length > 1 ? [createActionRow(currentPageIndex, pages.length)] : []
                    });

                    if (pages.length <= 1) return;

                    const filter = i => i.user.id === interaction.user.id;
                    const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

                    collector.on('collect', async i => {
                        try {
                            await i.deferUpdate();
                            if (i.customId === 'page_back') currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                            else if (i.customId === 'page_next') currentPageIndex = (currentPageIndex + 1) % pages.length;

                            embed.setDescription(pages[currentPageIndex])
                                .setFooter(generateFooter(currentPageIndex, pages.length));
                            await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                        } catch (collectError) {
                            logger.error(`[TopicalIndex Command - ShowAll] Collector error: ${collectError}`);
                        }
                    });

                    collector.on('end', () => {
                        const finalComponents = createActionRow(currentPageIndex, pages.length, true);
                        message.edit({ components: [finalComponents] }).catch(e => {
                            if (e.code !== 10008) logger.error(`[TopicalIndex Command - ShowAll] Error disabling components: ${e}`);
                        });
                    });

                    return;
                } catch (dbError) {
                    logger.error(`[TopicalIndex Command - ShowAll] DB query failed: ${dbError.message}`);
                    return interaction.editReply({ content: 'Sorry, failed to fetch the list of topics.', ephemeral: true });
                }
            }

            logger.info(`[TopicalIndex Command] Searching for topic: "${topic}"`);

            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[TopicalIndex Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            const verseReferences = await categoriesWrapper.getRefsForTopic(topic);

            if (!verseReferences || verseReferences.length === 0) {
                return interaction.editReply({
                    content: `❌ Topic "${topic}" not found. Use \`/topicalindex showall:true\` to see available topics.`,
                    ephemeral: true
                });
            }

            const verseCount = verseReferences.length.toString();
            logger.info(`[TopicalIndex Command] Found ${verseCount} references for "${topic}"`);

            const totalPages = Math.ceil(verseReferences.length / ITEMS_PER_PAGE);
            let currentPageIndex = 0;

            const initialPageRefs = verseReferences.slice(0, ITEMS_PER_PAGE);
            const initialPageContent = await formatVersesForPage(initialPageRefs, translation);

            const embed = new EmbedBuilder()
                .setTitle(`📖 Bible Verses about "${rawTopic}"`)
                .setDescription(initialPageContent)
                .setColor(embedColor)
                .addFields([{ name: 'Total Related Verses', value: verseCount, inline: true }])
                .setFooter(generateFooter(currentPageIndex, totalPages, translation));

            const message = await interaction.editReply({
                embeds: [embed],
                components: totalPages > 1 ? [createActionRow(currentPageIndex, totalPages)] : []
            });

            if (totalPages <= 1) return;

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({ filter, time: COLLECTOR_TIMEOUT_MS });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    let newPageIndex = currentPageIndex;
                    if (i.customId === 'page_back') newPageIndex--;
                    else if (i.customId === 'page_next') newPageIndex++;

                    newPageIndex = Math.max(0, Math.min(newPageIndex, totalPages - 1));

                    if (newPageIndex !== currentPageIndex) {
                        currentPageIndex = newPageIndex;
                        const start = currentPageIndex * ITEMS_PER_PAGE;
                        const end = start + ITEMS_PER_PAGE;
                        const pageRefs = verseReferences.slice(start, end);

                        const pageContent = await formatVersesForPage(pageRefs, translation);

                        embed.setDescription(pageContent)
                            .setFooter(generateFooter(currentPageIndex, totalPages, translation));

                        await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, totalPages)] });
                    }
                } catch (collectError) {
                    logger.error(`[TopicalIndex Command - Search] Collector error: ${collectError}`);
                }
            });

            collector.on('end', () => {
                logger.info(`[TopicalIndex Command - Search] Pagination collector ended for topic "${topic}"`);
                const finalComponents = createActionRow(currentPageIndex, totalPages, true);
                message.edit({ components: [finalComponents] }).catch(e => {
                    if (e.code !== 10008) logger.error(`[TopicalIndex Command - Search] Error disabling components: ${e}`);
                });
            });
        } catch (error) {
            logger.error(`[TopicalIndex Command] Unhandled error: ${error.message}`, error.stack);
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: '❌ Sorry, there was an unexpected error.', ephemeral: true });
                } else {
                    await interaction.editReply({ content: '❌ Sorry, there was an unexpected error.', embeds: [], components: [], ephemeral: true });
                }
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[TopicalIndex Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
