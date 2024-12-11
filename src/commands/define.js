const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const splitString = require('../utils/splitString.js');
const { strongsWrapper } = require('../utils/bibleHelper.js');

function generateFooter(currentPage, totalPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${currentPage + 1}/${totalPages}`,
        iconURL: process.env.EMBEDICONURL
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('define')
        .setDescription('Look up the meaning of words in Hebrew or Greek')
        .addStringOption(option =>
            option.setName('lexiconid')
                .setDescription('Choose Hebrew or Greek lexicon')
                .setRequired(true)
                .addChoices(
                    { name: '🔵 Hebrew', value: 'Hebrew' },
                    { name: '🟣 Greek', value: 'Greek' }
                ))
        .addStringOption(option => 
            option.setName('word')
                .setDescription('Enter an English word or Strong\'s number (e.g. H1254 or G3056)')
                .setRequired(true)
                .setMaxLength(250)),

    async execute(interaction) {
        await interaction.deferReply();

        let word = swearWordFilter(interaction.options.getString('word'));
        let lexiconId = interaction.options.getString('lexiconid');
        
        const wordContainsNumbers = /\d/.test(word);

        const result = wordContainsNumbers 
            ? [await strongsWrapper.getStrongsId(lexiconId, word)] 
            : await strongsWrapper.getStrongsEnglish(lexiconId, word);

        if (!result) {
            return interaction.editReply({ 
                content: `❌ No results found for "${word}" in the ${lexiconId} lexicon.`,
                ephemeral: true 
            });
        }

        // Group results into pages of 5
        const itemsPerPage = 5;
        const pages = [];
        for (let i = 0; i < result.length; i += itemsPerPage) {
            const pageItems = result.slice(i, i + itemsPerPage);
            
            const embed = new EmbedBuilder()
                .setTitle(`📚 ${lexiconId} Word Study - "${word}"`)
                .setColor(lexiconId === "Greek" ? 0x9B59B6 : 0x3498DB)
                .setURL(process.env.WEBSITE);

            const descriptions = pageItems.map((item, index) => {
                const strongsNumber = `${lexiconId === "Greek" ? "G" : "H"}${item.strongs}`;
                const definition = lexiconId === "Greek" ? 
                    (item.definition || item.strong_def) : 
                    item.strong_def;
                    
                return [
                    `### ${index + 1 + (i * itemsPerPage)}. ${strongsNumber}`,
                    '',
                    `**Original Word:** ${item.unicode}`,
                    `**Transliteration:** ${item.translit || item.xlit || "N/A"}`,
                    '',
                    `**Definition:**\n${definition}`,
                    '―――――――――――――――'
                ].join('\n');
            });

            embed.setDescription(descriptions.join('\n\n'));
            pages.push(embed);
        }

        if (pages.length === 1) {
            return interaction.editReply({ embeds: [pages[0]] });
        }

        // Setup pagination
        let currentPage = 0;

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('page_back')
                    .setLabel('Previous')
                    .setEmoji('◀️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(true),
                new ButtonBuilder()
                    .setCustomId('page_next')
                    .setLabel('Next')
                    .setEmoji('▶️')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(pages.length === 1)
            );

        const response = await interaction.editReply({
            embeds: [pages[0].setFooter(generateFooter(currentPage, pages.length))],
            components: [row]
        });

        const collector = response.createMessageComponentCollector({ 
            componentType: ComponentType.Button, 
            time: 300000 // 5 minutes
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ 
                    content: '❌ You cannot use these buttons', 
                    ephemeral: true 
                });
            }

            currentPage = i.customId === 'page_back'
                ? (currentPage === 0 ? pages.length - 1 : currentPage - 1)
                : (currentPage === pages.length - 1 ? 0 : currentPage + 1);

            const updatedRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setLabel('Previous')
                        .setEmoji('◀️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === 0),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setLabel('Next')
                        .setEmoji('▶️')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(currentPage === pages.length - 1)
                );

            await i.update({ 
                embeds: [pages[currentPage].setFooter(generateFooter(currentPage, pages.length))],
                components: [updatedRow]
            });
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });
    },
};