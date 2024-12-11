const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const splitString = require('../utils/splitString');
const { getBookId } = require('../utils/bibleHelper');
require('dotenv').config();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('commentary')
        .setDescription('Look up Gill\'s Bible Commentary for a specific verse')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book you want to find commentary for!')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter you want to find commentary for!')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse you want to find commentary for!')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawBook = interaction.options.getString('book');
            const chapter = parseInt(interaction.options.getString('chapter'));
            const verse = interaction.options.getNumber('verse');

            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ 
                    content: 'Please provide a valid chapter number.',
                    ephemeral: true 
                });
            }

            // Get book ID using the existing helper function
            const bookId = getBookId(rawBook);
            if (!bookId) {
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                    ephemeral: true 
                });
            }

            // Format verse ID as required by the API (e.g., "01001001" for Genesis 1:1)
            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}`;
            logger.info(`[Commentary Command] Looking up commentary for verse ID: ${verseId}`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetCommentary',
                params: {
                    commentaryName: 'gills',
                    verseId: verseId
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            logger.debug('Commentary API Response:', response.data);

            if (!response.data) {
                await interaction.editReply(`No commentary found for this verse.`);
                return;
            }

            // Clean and process the commentary text
            let commentaryText = response.data;
            if (typeof commentaryText !== 'string') {
                commentaryText = JSON.stringify(commentaryText);
            }

            // Clean up the text
            commentaryText = commentaryText
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, '&')
                // Remove references in curly braces and their content
                .replace(/\{[^}]+\}/g, '')
                // Remove references like T. Bab. Pesachim, etc.
                .replace(/T\. Bab\.[^\.]+\./g, '')
                // Remove references in parentheses at the end of lines
                .replace(/\([^)]+\)\./g, '.')
                // Clean up multiple spaces
                .replace(/\s+/g, ' ')
                // Clean up multiple newlines
                .replace(/\n+/g, '\n\n')
                // Remove any remaining citations
                .replace(/\s*\([^)]+\)\s*/g, ' ')
                .trim();

            // Add a note about the commentary source
            commentaryText = `*From Gill's Exposition of the Bible*\n\n${commentaryText}`;

            // Split into chunks for pagination if needed
            const chunks = splitString(commentaryText, 1900);

            // Create the first embed
            const embed = new EmbedBuilder()
                .setColor(eval(process.env.EMBEDCOLOR))
                .setTitle(`📖 Gill's Commentary: ${rawBook} ${chapter}:${verse}`)
                .setDescription(chunks[0])
                .setURL(process.env.WEBSITE)
                .setFooter({
                    text: `${process.env.EMBEDFOOTERTEXT} | Page 1/${chunks.length}`,
                    iconURL: process.env.EMBEDICONURL
                });

            // If there's only one chunk, just send it
            if (chunks.length === 1) {
                await interaction.editReply({ embeds: [embed] });
                return;
            }

            // If there are multiple chunks, add navigation buttons
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
                        .setDisabled(chunks.length <= 1)
                );

            const response2 = await interaction.editReply({
                embeds: [embed],
                components: [row]
            });

            const collector = response2.createMessageComponentCollector({ 
                componentType: ComponentType.Button, 
                time: 1_800_000  // 30 minutes
            });

            let currentPage = 0;

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ 
                        content: '⚠️ These buttons are only for the user who ran the command.', 
                        ephemeral: true 
                    });
                    return;
                }

                const selection = i.customId;
                currentPage = (selection === "page_back") 
                    ? (currentPage === 0 ? chunks.length - 1 : currentPage - 1)
                    : (currentPage === chunks.length - 1 ? 0 : currentPage + 1);

                // Update buttons with new style
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('page_back')
                            .setEmoji('◀️')
                            .setLabel('Previous')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPage === 0),
                        new ButtonBuilder()
                            .setCustomId('page_next')
                            .setEmoji('▶️')
                            .setLabel('Next')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPage === chunks.length - 1)
                    );

                // Update embed with new style
                const embed = new EmbedBuilder()
                    .setColor(eval(process.env.EMBEDCOLOR))
                    .setTitle(`📖 Gill's Commentary: ${rawBook} ${chapter}:${verse}`)
                    .setDescription(chunks[currentPage])
                    .setURL(process.env.WEBSITE)
                    .setFooter({
                        text: `${process.env.EMBEDFOOTERTEXT} | Page ${currentPage + 1}/${chunks.length}`,
                        iconURL: process.env.EMBEDICONURL
                    });

                await i.update({ embeds: [embed], components: [row] });
            });

            // Add collector end handling to match other commands
            collector.on('end', async () => {
                const disabledRow = new ActionRowBuilder()
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
                            .setDisabled(true)
                    );

                await response2.edit({ components: [disabledRow] }).catch(() => {});
            });

        } catch (error) {
            logger.error('Commentary command error:', error.response?.data || error);
            await interaction.editReply('Sorry, there was an error fetching the commentary. Please try again later.');
        }
    },
}; 