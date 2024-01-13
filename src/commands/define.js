const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const splitString = require('../utils/splitString');
const { strongsWrapper } = require('../utils/bibleHelper.js')
module.exports = {
    data: new SlashCommandBuilder()
        .setName('define')
        .setDescription('Returns the strong of a word!')
        .addStringOption(option =>
            option.setName('lexiconid')
                .setDescription('The lexicon id to use!')
                .setRequired(true)
                .addChoices(
                    { name: 'Hebrew', value: 'Hebrew' },
                    { name: 'Greek', value: 'Greek' }
                ))
        .addStringOption(option => option.setName('word').setDescription('The english word you want to find the original, OR a strongs id!').setRequired(true).setMaxLength(250)),
    async execute(interaction) {
        await interaction.deferReply();

        let word = swearWordFilter(interaction.options.getString('word'));
        let lexiconId = interaction.options.getString('lexiconid');
        
        const wordContainsNumbers = /\d/.test(word);

        const result = wordContainsNumbers ? [await strongsWrapper.getStrongsId(lexiconId, word)] : await strongsWrapper.getStrongsEnglish(lexiconId, word);

        if (!result) return interaction.editReply({ content: `I couldn't find any words related to ${word}!` });

        let response = `**"${wordContainsNumbers ? lexiconId == "Greek" ? "G" : "H" + word : word}"**\n>>> `;  

        for (const item of result) {
            response += `${lexiconId == "Greek" ? "G" : "H"}${item.strongs} - ${item.unicode} ${(item.translit ? "(" + item.translit + ")"  : "(" + item.xlit + ")" ) || " None"} - ${item.strong_def}\n`;
        }

        const splitResponse = splitString(response);

        if (splitResponse.length > 1) {
            let currentPage = 0;

            const paginationButtons = [
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("⬅️").setCustomId("page_back"),
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("➡️").setCustomId("page_next")
            ];

            const row = new ActionRowBuilder()
                .addComponents(...paginationButtons);

            const response = await interaction.editReply({
                content: splitResponse[0],
                components: [row],
            });

            const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 1_800_000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'You cannot use this button 💔', ephemeral: true });

                const selection = i.customId;

                currentPage = (selection == "page_back") 
                ? (currentPage == 0 ? splitResponse.length - 1 : currentPage - 1) // If the current page is 0, go to the last page, otherwise go back one page
                : (currentPage == splitResponse.length - 1 ? 0 : currentPage + 1); // If the current page is the last page, go to the first page, otherwise go forward one page

                await interaction.editReply({ content: splitResponse[currentPage], ephemeral: true });

                i.deferUpdate();
            });
            
        } else {
            return interaction.editReply({ content: splitResponse[0] });
        }

    },
};