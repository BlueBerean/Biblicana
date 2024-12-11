const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType } = require('discord.js');
const swearWordFilter = require('../utils/filter');
const logger = require('../utils/logger');
const axios = require('axios');

function generateFooter(page = 0, maxPages = 1) {
    const pageText = maxPages > 1 ? ` | Page ${page + 1}/${maxPages}` : '';
    return { 
        text: `${process.env.EMBEDFOOTERTEXT}${pageText}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

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
        
            // Handle the error and provide a "meaningful" response to the user
            return await interaction.editReply({ content: 'An error occurred while trying to fetch data. Please try again later.' });
        }

        const embed = new EmbedBuilder()
            .setTitle(`📚 Topic Study: ${topic}`)
            .setDescription('Here are some relevant commentaries and insights about this topic:')
            .setURL(process.env.WEBSITE)
            .setColor(eval(process.env.EMBEDCOLOR));

        let fields = response.data.results.slice(0, 19).map(result => ({
            name: result.context.length > 256 
                ? result.context.substring(0, 250) + "..." 
                : result.context,
            value: (result.text.length > 1024 
                ? result.text.substring(0, 1021) + "..." 
                : result.text) + "\n\n─────────────────────",
            inline: false
        }));

        const maxVerses = 5;
        let pages = [];
        
        // Create pages with fields
        for (let i = 0; i < fields.length; i += maxVerses) {
            pages.push(fields.slice(i, i + maxVerses));
        }

        if (pages.length === 0) {
            return await interaction.editReply({ 
                content: 'I couldn\'t find any commentaries related to that topic!' 
            });
        }

        let currentPageIndex = 0;
        embed.addFields(pages[0])
             .setFooter(generateFooter(currentPageIndex, pages.length));

        if (pages.length === 1) {
            const disclaimerRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setLabel("💡 Disclaimer")
                        .setCustomId("bias_alert")
                );
            
            return interaction.editReply({ 
                embeds: [embed], 
                components: [disclaimerRow] 
            });
        }

        // Add pagination for multiple pages
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
                    .setDisabled(pages.length === 1),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("💡 Disclaimer")
                    .setCustomId("bias_alert")
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
                    content: 'You cannot use these buttons!', 
                    ephemeral: true 
                });
                return;
            }

            if (i.customId === 'bias_alert') {
                await i.reply({
                    content: '⚠ Please note that these commentaries represent various theological perspectives and interpretations. Always compare with Scripture and use discernment.',
                    ephemeral: true
                });
                return;
            }

            if (i.customId === 'page_next') {
                currentPageIndex++;
                if (currentPageIndex >= pages.length) currentPageIndex = 0;
            } else if (i.customId === 'page_back') {
                currentPageIndex--;
                if (currentPageIndex < 0) currentPageIndex = pages.length - 1;
            }

            const updatedRow = new ActionRowBuilder()
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
                        .setDisabled(currentPageIndex === pages.length - 1),
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setLabel("💡 Disclaimer")
                        .setCustomId("bias_alert")
                );

            embed.setFields(pages[currentPageIndex])
                 .setFooter(generateFooter(currentPageIndex, pages.length));

            await i.update({ 
                embeds: [embed], 
                components: [updatedRow] 
            });
        });
    },
};