import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import axios from 'axios';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

function generateFooter(page, maxPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${page + 1}/${maxPages}`,
        iconURL: process.env.EMBEDICONURL
    };
}

function getBookSections(bookInfo) {
    const formatArray = (arr, prefix = '• ') => Array.isArray(arr) && arr.length > 0 ? prefix + arr.join(`\n${prefix}`) : (arr || null);
    const formatKeyVerses = (arr) => Array.isArray(arr) && arr.length > 0 ? '• ' + arr.map(v => v.reference).join('\n• ') : (arr || null);

    return [
        { title: 'Introduction', content: bookInfo.introduction },
        { title: 'Summary', content: bookInfo.summary },
        { title: 'Author & Date', content: bookInfo.author && bookInfo.date ? `${bookInfo.author}\nDate: ${bookInfo.date}` : (bookInfo.author || bookInfo.date || null) },
        { title: 'Genre & Language', content: bookInfo.genre || (bookInfo.original_language && bookInfo.original_language_meaning) ? `Genre: ${bookInfo.genre || 'N/A'}\nOriginal Language: ${bookInfo.original_language || 'N/A'} (${bookInfo.original_language_meaning || 'N/A'})` : null },
        { title: 'Structure', content: bookInfo.structure },
        { title: 'Historical Context', content: bookInfo.historical_context },
        { title: 'Purpose', content: bookInfo.purpose },
        { title: 'Audience', content: bookInfo.audience },
        { title: 'Major Characters', content: formatArray(bookInfo.major_characters) },
        { title: 'Themes', content: formatArray(bookInfo.themes) },
        { title: 'Key Verses', content: formatKeyVerses(bookInfo.key_verses) },
        { title: 'Practical Application', content: bookInfo.practical_application },
        { title: 'Connection to Other Books', content: bookInfo.connection_to_other_books },
        { title: 'Theological Significance', content: bookInfo.theological_introduction ? bookInfo.theological_introduction.split('\n')[0] : null },
        { title: 'Cross References', content: formatArray(bookInfo.cross_references) },
        { title: 'Symbolism', content: formatArray(bookInfo.symbolism) }
    ].filter(section => section.content && section.content.toString().trim());
}

export default {
    data: new SlashCommandBuilder()
        .setName('bookinfo')
        .setDescription('Get detailed information about a book of the Bible')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want to learn about')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawBook = interaction.options.getString('book');
            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);

            if (!bookId) {
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                    ephemeral: true
                });
            }

            logger.info(`[BookInfo Command] Looking up information for book: ${bookName} (ID: ${bookId})`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetBookInfo',
                params: {
                    bookId: bookId.toString().padStart(2, '0'),
                    language: 'english'
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            const bookInfo = response.data;

            if (!bookInfo) {
                return interaction.editReply(`No information found for ${bookName}.`);
            }

            const sections = getBookSections(bookInfo);

            if (sections.length === 0) {
                return interaction.editReply(`No detailed information available for ${bookName}.`);
            }

            const maxChars = 4000;
            const pages = [];
            let currentPage = '';

            for (const section of sections) {
                const contentString = Array.isArray(section.content) ? section.content.join('\n') : String(section.content);
                const sectionText = `**${section.title}:**\n${contentString}\n\n`;

                if ((currentPage + sectionText).length > maxChars) {
                    if (currentPage) {
                        pages.push(currentPage.trim());
                    }
                    currentPage = sectionText;
                } else {
                    currentPage += sectionText;
                }
            }

            if (currentPage) {
                pages.push(currentPage.trim());
            }

            if (pages.length === 0) {
                return interaction.editReply(`No processable information available for ${bookName}.`);
            }

            let currentPageIndex = 0;

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📖 Book Information - ${bookName}`)
                .setDescription(pages[currentPageIndex])
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(currentPageIndex, pages.length));

            if (pages.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            const createActionRow = (isEnd = false) => new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setEmoji('◀️')
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isEnd || currentPageIndex === 0),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setEmoji('▶️')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(isEnd || currentPageIndex === pages.length - 1)
                );

            const message = await interaction.editReply({
                embeds: [embed],
                components: [createActionRow()]
            });

            const filter = i => i.user.id === interaction.user.id;

            const collector = message.createMessageComponentCollector({
                filter,
                time: 600000
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
                        .setFooter(generateFooter(currentPageIndex, pages.length));

                    await i.editReply({ embeds: [embed], components: [createActionRow()] });
                } catch (collectError) {
                    logger.error(`[BookInfo Command] Error updating pagination: ${collectError}`);
                    try {
                        await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                    } catch (followUpError) {
                        logger.error(`[BookInfo Command] Error sending follow-up after pagination error: ${followUpError}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[BookInfo Command] Pagination collector ended for ${bookName} after timeout.`);
                const timedOutRow = createActionRow(true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    logger.error(`[BookInfo Command] Error disabling buttons after timeout: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[BookInfo Command] Error: ${error.message}`, error.stack);
            if (error.response) {
                logger.error(`[BookInfo Command] API Error Status: ${error.response.status}`);
                logger.error(`[BookInfo Command] API Error Data: ${JSON.stringify(error.response.data)}`);
            }
            try {
                await interaction.editReply({
                    content: 'Sorry, there was an error processing your request. The developers have been notified.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[BookInfo Command] Failed to send error reply: ${replyError}`);
            }
        }
    }
};
