const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { getBookId, bibleWrapper, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

function generateFooter(translation = "BSB", page, maxPages) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Top Translation: ${translation.toUpperCase()}${pageText}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('parallel')
        .setDescription('Find parallel verses in the Bible')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book you want to find parallel verses for')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter you want to find parallel verses for')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse you want to find parallel verses for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
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
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            
            const rawBook = interaction.options.getString('book');
            const chapter = parseInt(interaction.options.getString('chapter'));
            const verse = interaction.options.getNumber('verse');

            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ 
                    content: 'Please provide a valid chapter number.',
                    ephemeral: true 
                });
            }

            const bookId = getBookId(rawBook);
            if (!bookId) {
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                    ephemeral: true 
                });
            }

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}`;
            logger.info(`[Parallel Command] Looking up parallel verses for verse ID: ${verseId}`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetParallelVerses',
                params: { verseId },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const [response, originalVerse] = await Promise.all([
                axios.request(options),
                bibleWrapper.getVerses(bookId, chapter, verse, verse)
            ]);

            // Add logging to see the API response structure
            logger.info('[Parallel Command] API Response:', JSON.stringify(response.data, null, 2));

            if (!response.data || response.data.length === 0) {
                return interaction.editReply(`No parallel verses found for ${numbersToBook.get(bookId)} ${chapter}:${verse}.`);
            }

            if (!originalVerse || originalVerse.length === 0) {
                return interaction.editReply('Error: Could not fetch the original verse text.');
            }

            // Create pages of parallel verses
            const maxChars = 1900;
            const pages = [];
            const originalVerseText = originalVerse[0][translation];
            const verseReference = `**${numbersToBook.get(bookId)} ${chapter}:${verse} (${translation})**`;
            let currentPage = `${verseReference}\n${originalVerseText}\n\n**Parallel Translations:**\n`;

            // Process the translations
            const translations = response.data.map(translationArray => {
                if (!Array.isArray(translationArray) || translationArray.length === 0) return null;
                const version = translationArray[0];
                if (!version || !version.versionAbbreviation || !version.t) return null;
                
                return `• **${version.versionAbbreviation}**: ${version.t}\n`;
            }).filter(Boolean);

            // Split translations into pages
            for (const translation of translations) {
                if ((currentPage + translation).length > maxChars) {
                    pages.push(currentPage);
                    currentPage = `${verseReference}\n${originalVerseText}\n\n**Parallel Translations:**\n${translation}`;
                } else {
                    currentPage += translation;
                }
            }

            if (currentPage) {
                pages.push(currentPage);
            }

            // If no valid translations were found
            if (pages.length === 0) {
                return interaction.editReply(`No parallel translations found for ${numbersToBook.get(bookId)} ${chapter}:${verse}.`);
            }

            let currentPageIndex = 0;
            const embed = new EmbedBuilder()
                .setTitle(`Parallel Translations - ${numbersToBook.get(bookId)} ${chapter}:${verse}`)
                .setDescription(pages[0])
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, currentPageIndex, pages.length));

            // Only add pagination buttons if there are multiple pages
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
                        .setDisabled(pages.length <= 1)
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
                     .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                await i.update({ embeds: [embed], components: [row] });
            });

        } catch (error) {
            logger.error('[Parallel Command] Error:', error);
            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 