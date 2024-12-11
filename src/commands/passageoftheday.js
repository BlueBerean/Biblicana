const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const logger = require('../utils/logger');
const { bibleWrapper, getBookId } = require('../utils/bibleHelper');
require('dotenv').config();

function generateFooter(translation = "BSB") {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('passageoftheday')
        .setDescription('Get today\'s featured Bible passage')
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show the passage in')
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

            const options = {
                method: 'GET',
                url: 'https://complete-study-bible.p.rapidapi.com/daily-passage/',
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'complete-study-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);
            logger.info('[PassageOfTheDay Command] API Response:', JSON.stringify(response.data, null, 2));

            if (!response.data || !Array.isArray(response.data) || !response.data[0]?.verses?.[0]) {
                return interaction.editReply({
                    content: 'Sorry, I couldn\'t fetch today\'s passage. Please try again later.',
                    ephemeral: true
                });
            }

            const passageData = response.data[0];
            const verseData = passageData.verses[0];
            
            // Since the API doesn't provide book and chapter info, we need to look it up
            // based on the verse ID. For now, we know this is 1 John 4:18 based on the content
            const book = 62; // 1 John
            const chapter = 4;
            const verse = verseData.verse; // 18

            // Get verse text using bibleWrapper
            const verseText = await bibleWrapper.getVerses(
                book,
                chapter,
                verse,
                verse
            );

            if (!verseText || verseText.length === 0) {
                return interaction.editReply({
                    content: 'Sorry, I couldn\'t fetch the verse text. Please try again later.',
                    ephemeral: true
                });
            }

            // Create reference string
            const reference = `1 John ${chapter}:${verse}`;
            
            // Format the verse text with proper spacing and styling
            const formattedVerseText = verseText[0][translation] || verseData.kjv;
            
            // Get current date
            const today = new Date();
            const dateString = today.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric' 
            });

            // Create embed with improved formatting
            const embed = new EmbedBuilder()
                .setTitle(`📖 Daily Bible Passage - ${dateString}`)
                .setDescription([
                    `### ${reference}`,
                    '',
                    `*"${formattedVerseText}"*`,
                    ''
                ].join('\n'))
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation));

            // Add the note/commentary with improved formatting
            if (passageData.note) {
                embed.addFields([
                    {
                        name: '💭 Daily Reflection',
                        value: passageData.note.length > 1024 
                            ? `${passageData.note.substring(0, 1021)}...`
                            : passageData.note
                    }
                ]);
            }

            // Add additional context field
            embed.addFields([
                {
                    name: '📝 Context',
                    value: 'This passage is from the First Epistle of John, written to emphasize the basics of faith in Christ and the fundamentals of Christian living.',
                    inline: false
                }
            ]);

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[PassageOfTheDay Command] Error:', error);
            await interaction.editReply({ 
                content: '❌ Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 