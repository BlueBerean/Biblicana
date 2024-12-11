const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const splitString = require('../utils/splitString');
require('dotenv').config();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dictionary')
        .setDescription('Look up a word in Smith\'s Bible Dictionary')
        .addStringOption(option =>
            option.setName('word')
                .setDescription('The word to look up')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const searchWord = interaction.options.getString('word');

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetDefinitionBiblical',
                params: {
                    query: searchWord,
                    dictionaryId: 'smiths'
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            logger.debug('Dictionary API Response:', response.data);
            
            if (!response.data || typeof response.data === 'string') {
                await interaction.editReply(`No definition found for "${searchWord}"`);
                return;
            }

            // Get definition text and clean it up
            let definitionText = '';
            if (Array.isArray(response.data)) {
                definitionText = response.data
                    .map(def => cleanDefinitionText(def.definition || def.text || def))
                    .filter(def => def)
                    .join('\n\n');
            } else {
                definitionText = cleanDefinitionText(response.data.definition || response.data.text || JSON.stringify(response.data));
            }

            if (!definitionText) {
                await interaction.editReply(`No clear definition found for "${searchWord}"`);
                return;
            }

            // Split the definition into chunks of 1500 characters (leaving room for formatting)
            const chunks = splitString(definitionText, 1500);
            
            // Create the first embed
            const embed = new EmbedBuilder()
                .setColor(parseInt(process.env.EMBEDCOLOR))
                .setTitle(`📚 Smith's Definition: ${searchWord}`)
                .setDescription(chunks[0])
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
            const paginationButtons = [
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji("◀️")
                    .setLabel("Previous")
                    .setCustomId("page_back"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji("▶️")
                    .setLabel("Next")
                    .setCustomId("page_next")
            ];

            const row = new ActionRowBuilder().addComponents(...paginationButtons);

            let currentPage = 0;

            const response2 = await interaction.editReply({
                embeds: [embed],
                components: [row]
            });

            const collector = response2.createMessageComponentCollector({ 
                componentType: ComponentType.Button, 
                time: 1_800_000 // 30 minutes, matching find.js
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    return i.reply({ content: 'You cannot use this button!', ephemeral: true });
                }

                if (i.customId === 'page_next') {
                    currentPage++;
                    if (currentPage > (chunks.length - 1)) currentPage = 0;
                } else if (i.customId === 'page_back') {
                    currentPage--;
                    if (currentPage < 0) currentPage = chunks.length - 1;
                }

                await i.update({
                    embeds: [new EmbedBuilder()
                        .setColor(parseInt(process.env.EMBEDCOLOR))
                        .setTitle(`📚 Definition: ${searchWord}`)
                        .setDescription(chunks[currentPage])
                        .setFooter({
                            text: `${process.env.EMBEDFOOTERTEXT} | Page ${currentPage + 1}/${chunks.length}`,
                            iconURL: process.env.EMBEDICONURL
                        })
                    ],
                    components: [row]
                });
            });

        } catch (error) {
            logger.error('Dictionary command error:', error.response?.data || error);
            await interaction.editReply('Sorry, there was an error fetching the definition. Please try again later.');
        }
    },
};

function cleanDefinitionText(text) {
    if (!text) return '';
    
    let cleanText = text
        // Remove reference links
        .replace(/\(<reflink[^>]*>[^<]*<\/reflink>\)/g, '')
        // Format initial definition in parentheses
        .replace(/^\((.*?)\)/, '*($1)*\n\n')
        // Remove other bible references in parentheses
        .replace(/\([^)]*\d+:\d+[^)]*\)/g, '')
        // Remove content within square brackets
        .replace(/\[[^\]]*\]/g, '')
        // Remove content within angle brackets
        .replace(/<[^>]*>/g, '')
        // Remove extra whitespace
        .replace(/\s+/g, ' ')
        // Remove extra periods
        .replace(/\.+/g, '.')
        // Fix spacing after periods
        .replace(/\.\s*/g, '. ')
        // Remove extra spaces
        .trim();

    return cleanText;
} 