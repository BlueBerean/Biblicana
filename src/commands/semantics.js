const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
require('dotenv').config();

function createSemanticEmbed(word, pageContent, currentPage, totalPages) {
    return new EmbedBuilder()
        .setTitle(`📚 Semantic Relations for "${word}"`)
        .setDescription(pageContent)
        .setColor(eval(process.env.EMBEDCOLOR))
        .setURL(process.env.WEBSITE)
        .setFooter({ 
            text: `${process.env.EMBEDFOOTERTEXT} | Page ${currentPage + 1}/${totalPages}`, 
            iconURL: process.env.EMBEDICONURL 
        });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('semantics')
        .setDescription('Find semantic relations for a Biblical word or concept')
        .addStringOption(option => 
            option.setName('word')
                .setDescription('The word you want to find semantic relations for')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const word = interaction.options.getString('word');
            logger.info(`[Semantics Command] Looking up semantic relations for word: ${word}`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetSemanticRelations',
                params: { word },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            
            // Add logging to see the API response
            logger.info('[Semantics Command] API Response:', JSON.stringify(response.data, null, 2));

            if (!response.data || Object.keys(response.data).length === 0) {
                return interaction.editReply(`No semantic relations found for "${word}".`);
            }

            // Create pages of semantic relations
            const maxChars = 1900;
            const pages = [];
            let currentPage = '';

            // Process the response data
            const relations = response.data;
            
            // Add an introduction section
            currentPage += `🔍 Exploring semantic relationships for **${word}**\n\n`;
            
            // Handle each type of relation with improved formatting
            for (const type in relations) {
                if (relations[type] && Array.isArray(relations[type])) {
                    const words = relations[type].filter(word => word && word.trim());
                    if (words.length > 0) {
                        const formattedType = type.toLowerCase()
                            .replace(/_/g, ' ')
                            .replace(/\b\w/g, l => l.toUpperCase());

                        // Add emojis based on relation type
                        let emoji = '•';
                        switch(type.toLowerCase()) {
                            case 'synonyms': emoji = '🟢'; break;
                            case 'antonyms': emoji = '🔴'; break;
                            case 'related_terms': emoji = '🔵'; break;
                            case 'broader_terms': emoji = '⬆️'; break;
                            case 'narrower_terms': emoji = '⬇️'; break;
                            default: emoji = '•';
                        }

                        const section = `**${formattedType}:**\n${words.map(w => `${emoji} ${w}`).join('\n')}\n\n`;
                        
                        if ((currentPage + section).length > maxChars) {
                            pages.push(currentPage);
                            currentPage = section;
                        } else {
                            currentPage += section;
                        }
                    }
                }
            }

            if (currentPage) {
                pages.push(currentPage);
            }

            // If no valid relations were found
            if (pages.length === 0) {
                return interaction.editReply({
                    content: `❌ No semantic relations found for "${word}". Try a different word or check the spelling.`,
                    ephemeral: true
                });
            }

            let currentPageIndex = 0;
            const embed = createSemanticEmbed(word, pages[0], currentPageIndex, pages.length);

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
                time: 600000 // 10 minutes
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ 
                        content: '⚠️ These buttons are only for the user who ran the command.', 
                        ephemeral: true 
                    });
                    return;
                }

                if (i.customId === 'page_next') {
                    currentPageIndex = (currentPageIndex + 1) % pages.length;
                } else if (i.customId === 'page_back') {
                    currentPageIndex = (currentPageIndex - 1 + pages.length) % pages.length;
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

                const updatedEmbed = createSemanticEmbed(word, pages[currentPageIndex], currentPageIndex, pages.length);
                await i.update({ embeds: [updatedEmbed], components: [row] });
            });

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

                await message.edit({ components: [disabledRow] }).catch(() => {});
            });

        } catch (error) {
            logger.error('[Semantics Command] Error:', error);
            await interaction.editReply({ 
                content: '❌ Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 