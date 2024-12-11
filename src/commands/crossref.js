const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const { getBookId, bibleWrapper, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

function generateFooter(translation = "BSB", page, maxPages) {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('crossref')
        .setDescription('Find cross-references for a Bible verse')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book you want to find cross-references for!')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter you want to find cross-references for!')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse you want to find cross-references for!')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use!')
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
            logger.info(`[Crossref Command] Looking up cross-references for verse ID: ${verseId}`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetCrossReferences',
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

            if (!response.data || response.data.length === 0) {
                return interaction.editReply(`No cross-references found for ${numbersToBook.get(bookId)} ${chapter}:${verse}.`);
            }

            if (!originalVerse || originalVerse.length === 0) {
                return interaction.editReply('Error: Could not fetch the original verse text.');
            }

            // Create pages of cross-references
            const maxChars = 1900;
            const pages = [];
            let currentPage = `**📍 ${numbersToBook.get(bookId)} ${chapter}:${verse}**\n${originalVerse[0][translation]}\n\n**🔗 Cross References:**\n`;

            const processedRefs = await Promise.all(response.data.map(async ref => {
                const refId = parseInt(ref.sv.slice(0, 2));
                const refChapter = parseInt(ref.sv.slice(2, 5));
                const refVerse = parseInt(ref.sv.slice(5));

                const verseText = await bibleWrapper.getVerses(refId, refChapter, refVerse, refVerse);
                if (!verseText || !verseText.length) return null;

                return `• **${numbersToBook.get(refId)} ${refChapter}:${refVerse}** - ${verseText[0][translation]}\n`;
            }));

            for (const ref of processedRefs.filter(Boolean)) {
                if ((currentPage + ref).length > maxChars) {
                    pages.push(currentPage);
                    currentPage = `**📖 ${numbersToBook.get(bookId)} ${chapter}:${verse}**\n${originalVerse[0][translation]}\n\n**🔗 Cross References:**\n${ref}`;
                } else {
                    currentPage += ref;
                }
            }

            if (currentPage) {
                pages.push(currentPage);
            }

            if (pages.length === 1) {
                const embed = new EmbedBuilder()
                    .setTitle('📖 Cross References')
                    .setDescription(pages[0])
                    .setColor(eval(process.env.EMBEDCOLOR))
                    .setURL(process.env.WEBSITE)
                    .setFooter({ 
                        text: `${process.env.EMBEDFOOTERTEXT} | Translation: BSB`, 
                        iconURL: process.env.EMBEDICONURL 
                    });

                return interaction.editReply({ embeds: [embed] });
            }

            let currentPageIndex = 0;
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setEmoji('◀️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setEmoji('▶️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(pages.length <= 1)
                );

            const embed = new EmbedBuilder()
                .setTitle('📖 Cross References')
                .setDescription(pages[currentPageIndex])
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, currentPageIndex, pages.length));

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
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === 0),
                        new ButtonBuilder()
                            .setCustomId('page_next')
                            .setEmoji('▶️')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === pages.length - 1)
                    );

                embed.setDescription(pages[currentPageIndex])
                     .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                await i.update({ embeds: [embed], components: [row] });
            });

        } catch (error) {
            logger.error('[Crossref Command] Error:', error);
            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 