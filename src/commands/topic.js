const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const logger = require('../utils/logger');
const axios = require('axios');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('topic')
        .setDescription('Find a specific commentary related to a topic!')
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a commentary for!').setRequired(true).setMinLength(3).setMaxLength(250)),
    async execute(interaction) {
        await interaction.deferReply();

        const topic = swearWordFilter(interaction.options.getString('topic'));

        let response;
        try {
            response = await axios.get('https://uncovered-treasure-v1.p.rapidapi.com/search/' + topic, {
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'uncovered-treasure-v1.p.rapidapi.com'
                }
            });
        
            if (response.data.results.length < 1) {
                return await interaction.editReply({ content: 'I couldn\'t find any commentaries related to that topic!' });
            }

        } catch (error) {
            logger.error('API request failed:', error);
        
            // Handle the error and provide a meaningful response to the user
            return await interaction.editReply({ content: 'An error occurred while trying to fetch data. Please try again later.' });
        }



        const footer = { text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL };
        const embed = new EmbedBuilder()
            .setTitle(`Commentaries about ${topic}`)
            .setFooter(footer)
            .setURL(process.env.WEBSITE)
            .setColor(eval(process.env.EMBEDCOLOR));

        let fields = response.data.results.slice(0, 19).map(result => ({
            name: result.context.length > 256 ? result.context.substring(0, 250) + "..." : result.context,
            value: result.text.length > 1024 ? result.text.substring(0, 1021) + "..." : result.text
        }));

        const maxVerses = 5;

        if (fields.length > maxVerses) {
            const paginationButtons = [
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("⬅️").setCustomId("page_back"),
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("➡️").setCustomId("page_next")
            ];

            const row = new ActionRowBuilder()
                .addComponents(...paginationButtons);

            footer.text = process.env.EMBEDFOOTERTEXT + ` | Page 1/${Math.floor(fields.length / maxVerses) + 1}`;
            const response = await interaction.editReply({
                embeds: [embed.setFooter(footer).addFields(fields.slice(0, maxVerses))],
                components: [row],
            });

            let currentPage = 0;

            const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 1_800_000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'You cannot use this button!', ephemeral: true });

                if (i.customId === 'page_next') {
                    currentPage++;
                    if (currentPage > Math.floor(fields.length / maxVerses)) currentPage = 0;
                } else if (i.customId === 'page_back') {
                    currentPage--;
                    if (currentPage < 0) currentPage = Math.floor(fields.length / maxVerses);
                }
                
                const start = currentPage * maxVerses;
                const end = Math.min(start + maxVerses, fields.length);
                const slice = fields.slice(start, end);

                // If the slice is empty, wrap around to the beginning
                if (slice.length === 0 && fields.length > 0) {
                    const remaining = maxVerses - (start % maxVerses);
                    slice.push(...fields.slice(0, remaining));
                }

                embed.data.fields = []; // make sure to clear the fields before adding new ones
                footer.text = process.env.EMBEDFOOTERTEXT + ` | Page ${currentPage + 1}/${Math.floor(fields.length / maxVerses) + 1}`;
                await i.update({ embeds: [embed.setFooter(footer).addFields(slice)], components: [row] });
            });
        } else {
            embed.addFields(fields); 

    
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setLabel("Disclaimer")
                        .setCustomId("bias_alert"));
    
            return interaction.editReply({ embeds: [embed], components: [row] });
        }
    },
};