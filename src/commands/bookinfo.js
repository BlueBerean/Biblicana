const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { getBookId, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

function generateFooter(page, maxPages) {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${page + 1}/${maxPages}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

module.exports = {
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

            if (!bookId) {
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                    ephemeral: true 
                });
            }

            logger.info(`[BookInfo Command] Looking up information for book ID: ${bookId}`);

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
            logger.info('[BookInfo Command] API Response:', JSON.stringify(response.data, null, 2));

            if (!response.data) {
                return interaction.editReply(`No information found for ${numbersToBook.get(bookId)}.`);
            }

            // Create pages from the book information
            const maxChars = 1900;
            const pages = [];
            let currentPage = '';

            // Process the book information
            const bookInfo = response.data;
            const sections = [
                { title: 'Introduction', content: bookInfo.introduction },
                { title: 'Summary', content: bookInfo.summary },
                { title: 'Author & Date', content: `${bookInfo.author}\nDate: ${bookInfo.date}` },
                { title: 'Genre & Language', content: `Genre: ${bookInfo.genre}\nOriginal Language: ${bookInfo.original_language} (${bookInfo.original_language_meaning})` },
                { title: 'Structure', content: bookInfo.structure },
                { title: 'Historical Context', content: bookInfo.historical_context },
                { title: 'Purpose', content: bookInfo.purpose },
                { title: 'Audience', content: bookInfo.audience },
                { title: 'Major Characters', content: Array.isArray(bookInfo.major_characters) ? 
                    '• ' + bookInfo.major_characters.join('\n• ') : 
                    bookInfo.major_characters },
                { title: 'Themes', content: Array.isArray(bookInfo.themes) ? 
                    '• ' + bookInfo.themes.join('\n• ') : 
                    bookInfo.themes },
                { title: 'Key Verses', content: Array.isArray(bookInfo.key_verses) ? 
                    '• ' + bookInfo.key_verses.map(verse => verse.reference).join('\n• ') : 
                    bookInfo.key_verses },
                { title: 'Practical Application', content: bookInfo.practical_application },
                { title: 'Connection to Other Books', content: bookInfo.connection_to_other_books },
                { title: 'Theological Significance', content: bookInfo.theological_introduction ? 
                    bookInfo.theological_introduction.split('\n')[0] : null },
                { title: 'Cross References', content: Array.isArray(bookInfo.cross_references) ? 
                    '• ' + bookInfo.cross_references.join('\n• ') : 
                    bookInfo.cross_references },
                { title: 'Symbolism', content: Array.isArray(bookInfo.symbolism) ? 
                    '• ' + bookInfo.symbolism.join('\n• ') : 
                    bookInfo.symbolism }
            ];

            for (const section of sections) {
                if (section.content) {
                    const content = Array.isArray(section.content) ? section.content : section.content;
                    const sectionText = `**${section.title}:**\n${content}\n\n`;

                    if ((currentPage + sectionText).length > maxChars) {
                        pages.push(currentPage);
                        currentPage = sectionText;
                    } else {
                        currentPage += sectionText;
                    }
                }
            }

            if (currentPage) {
                pages.push(currentPage);
            }

            if (pages.length === 0) {
                return interaction.editReply(`No detailed information available for ${numbersToBook.get(bookId)}.`);
            }

            let currentPageIndex = 0;
            const embed = new EmbedBuilder()
                .setTitle(`📖 Book Information - ${numbersToBook.get(bookId)}`)
                .setDescription(pages[0])
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(currentPageIndex, pages.length));

            if (pages.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setEmoji('◀️')
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setEmoji('▶️')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(false)
                );

            const message = await interaction.editReply({ 
                embeds: [embed], 
                components: [row] 
            });

            const collector = message.createMessageComponentCollector({
                time: 600000
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: 'You cannot use this button!', ephemeral: true });
                    return;
                }

                if (i.customId === 'page_next') {
                    currentPageIndex++;
                    if (currentPageIndex > (pages.length - 1)) currentPageIndex = 0;
                } else if (i.customId === 'page_back') {
                    currentPageIndex--;
                    if (currentPageIndex < 0) currentPageIndex = pages.length - 1;
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('page_back')
                            .setEmoji('◀️')
                            .setLabel('Previous')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === 0),
                        new ButtonBuilder()
                            .setCustomId('page_next')
                            .setEmoji('▶️')
                            .setLabel('Next')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === pages.length - 1)
                    );

                embed.setDescription(pages[currentPageIndex])
                     .setFooter(generateFooter(currentPageIndex, pages.length));

                await i.update({ embeds: [embed], components: [row] });
            });

        } catch (error) {
            logger.error('[BookInfo Command] Error:', error);
            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 