import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { getBookId, bibleWrapper, numbersToBook } from '../utils/bibleHelper.js';
import { crossRefWrapper } from '../utils/studyHelper.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

const MAX_CHARS_PER_PAGE = 4000;
const COLLECTOR_TIMEOUT_MS = 600_000;

function generateFooter(translation = "BSB", page, maxPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`,
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
            .setDisabled(isEnd || currentPage === totalPages - 1)
    );

function formatRefRange(book, chapter, startVerse, endVerse) {
    if (endVerse && endVerse > startVerse) {
        return `${book} ${chapter}:${startVerse}-${endVerse}`;
    }
    return `${book} ${chapter}:${startVerse}`;
}

export default {
    data: new SlashCommandBuilder()
        .setName('crossref')
        .setDescription('Find cross-references for a Bible verse (Treasury of Scripture Knowledge)')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book of the Bible')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Bible translation to use (defaults to your saved preference or BSB)')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) {
                    translation = userPref.translation;
                }
            } catch (dbError) {
                logger.error(`[Crossref Command] Failed to get user preference from DB: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            const rawBook = interaction.options.getString('book');
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({
                    content: 'Please provide a valid chapter number (must be 1 or greater).',
                    ephemeral: true
                });
            }

            if (verseInput === null || !Number.isInteger(verseInput) || verseInput < 1) {
                return interaction.editReply({
                    content: 'Please provide a valid verse number (must be a whole number, 1 or greater).',
                    ephemeral: true
                });
            }
            const verse = verseInput;

            const bookId = getBookId(rawBook);
            const bookName = bookId ? numbersToBook.get(bookId) : null;
            if (!bookId || !bookName) {
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                    ephemeral: true
                });
            }

            logger.info(`[Crossref Command] Looking up cross-refs for ${bookName} ${chapter}:${verse} (Translation: ${translation})`);

            const [crossRefResult, originalVerseResult] = await Promise.allSettled([
                crossRefWrapper.getForVerse(bookName, chapter, verse),
                bibleWrapper.getVerses(bookId, chapter, verse, verse)
            ]);

            if (originalVerseResult.status === 'rejected' || !originalVerseResult.value || originalVerseResult.value.length === 0 || !originalVerseResult.value[0][translation]) {
                logger.error(`[Crossref Command] Failed to fetch original verse ${bookName} ${chapter}:${verse} (${translation}): ${originalVerseResult.reason?.message || 'Not Found'}`);
                return interaction.editReply({ content: `Sorry, I couldn't fetch the text for the original verse (${bookName} ${chapter}:${verse} - ${translation}). Please ensure the translation is available for this verse.`, ephemeral: true });
            }
            const originalVerseText = originalVerseResult.value[0][translation];
            const originalVerseRef = `**📍 ${bookName} ${chapter}:${verse} (${translation.toUpperCase()})**`;
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            if (crossRefResult.status === 'rejected' || !crossRefResult.value || crossRefResult.value.length === 0) {
                logger.warn(`[Crossref Command] No cross-references found for ${bookName} ${chapter}:${verse}: ${crossRefResult.reason?.message || 'Empty result'}`);
                const noRefsEmbed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(`${originalVerseRef}\n${originalVerseText}\n\nNo cross-references found for this verse.`)
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                    .setFooter({ text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL });
                return interaction.editReply({ embeds: [noRefsEmbed] });
            }

            const crossRefs = crossRefResult.value;
            logger.info(`[Crossref Command] Found ${crossRefs.length} cross-references`);

            const processedRefs = (await Promise.allSettled(crossRefs.map(async ref => {
                const refBookId = getBookId(ref.target_book);
                const refBookName = refBookId ? numbersToBook.get(refBookId) : null;
                if (!refBookId || !refBookName) {
                    logger.warn(`[Crossref Command] Unknown target book "${ref.target_book}" — skipping`);
                    return null;
                }

                const { target_chapter: refChapter, target_verse_start: startVerse, target_verse_end: endVerse } = ref;
                const fetchEnd = endVerse || startVerse;

                const verseData = await bibleWrapper.getVerses(refBookId, refChapter, startVerse, fetchEnd);
                if (!verseData || verseData.length === 0) return null;

                const verseText = verseData
                    .map(v => v[translation])
                    .filter(Boolean)
                    .join(' ');
                if (!verseText) return null;

                const refLabel = formatRefRange(refBookName, refChapter, startVerse, endVerse);
                return `• **${refLabel}** - ${verseText}\n`;
            })))
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

            if (processedRefs.length === 0) {
                logger.warn(`[Crossref Command] Found ${crossRefs.length} cross-ref rows but failed to fetch text for any in ${translation}`);
                const noTextEmbed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(`${originalVerseRef}\n${originalVerseText}\n\nCross-references were found, but I couldn't retrieve their text in the ${translation.toUpperCase()} translation.`)
                    .setColor(embedColor)
                    .setURL(process.env.WEBSITE)
                    .setFooter({ text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL });
                return interaction.editReply({ embeds: [noTextEmbed] });
            }

            const pages = [];
            let currentPageContent = `${originalVerseRef}\n${originalVerseText}\n\n**🔗 Cross References:**\n`;

            for (const refText of processedRefs) {
                if ((currentPageContent + refText).length > MAX_CHARS_PER_PAGE) {
                    pages.push(currentPageContent.trim());
                    currentPageContent = `${originalVerseRef}\n*Continued...*\n\n**🔗 Cross References:**\n${refText}`;
                } else {
                    currentPageContent += refText;
                }
            }
            pages.push(currentPageContent.trim());

            const embed = new EmbedBuilder()
                .setTitle('📖 Cross References')
                .setDescription(pages[0])
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, 0, pages.length));

            if (pages.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            let currentPageIndex = 0;
            const message = await interaction.editReply({
                embeds: [embed],
                components: [createActionRow(currentPageIndex, pages.length)]
            });

            const filter = i => i.user.id === interaction.user.id;
            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();
                    if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % pages.length;
                    } else if (i.customId === 'page_back') {
                        currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
                    }

                    embed.setDescription(pages[currentPageIndex])
                        .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow(currentPageIndex, pages.length)] });
                } catch (collectError) {
                    logger.error(`[Crossref Command] Error updating pagination: ${collectError}`);
                    try {
                        await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                    } catch { /* Ignore */ }
                }
            });

            collector.on('end', () => {
                logger.info(`[Crossref Command] Pagination collector ended for ${bookName} ${chapter}:${verse}`);
                const timedOutRow = createActionRow(currentPageIndex, pages.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    logger.error(`[Crossref Command] Error disabling buttons after timeout: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[Crossref Command] Error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: 'Sorry, there was an error processing your cross-reference request. Please try again later.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[Crossref Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
