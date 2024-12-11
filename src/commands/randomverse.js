const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const { getBookId, numbersToBook, bibleWrapper } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

// Helper function to create embed
function createVerseEmbed(bookId, chapter, verse, verseText, translation) {
    return new EmbedBuilder()
        .setTitle(`${numbersToBook.get(bookId)} ${chapter}:${verse}`)
        .setDescription(`<**${verse}**> ${verseText}`)
        .setColor(eval(process.env.EMBEDCOLOR))
        .setURL(process.env.WEBSITE)
        .setFooter({ 
            text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`, 
            iconURL: process.env.EMBEDICONURL 
        });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('randomverse')
        .setDescription('Get a random Bible verse')
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Limit to a specific book (optional)')
                .setRequired(false))
        .addNumberOption(option =>
            option.setName('chapter')
                .setDescription('Limit to a specific chapter (requires book)')
                .setRequired(false))
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
            // Get user preferences and options
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            
            // Handle optional book/chapter filters
            let bookId = null;
            let chapter = null;
            
            const rawBook = interaction.options.getString('book');
            if (rawBook) {
                bookId = getBookId(rawBook);
                if (!bookId) {
                    return interaction.editReply({ 
                        content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                        ephemeral: true 
                    });
                }
                
                chapter = interaction.options.getNumber('chapter');
                if (chapter && (isNaN(chapter) || chapter < 1)) {
                    return interaction.editReply({ 
                        content: 'Please provide a valid chapter number.',
                        ephemeral: true 
                    });
                }
            }

            // Set up API request with KJV as base translation for getting random verse
            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetRandomVerse',
                params: {
                    versionId: 'kjv' // Always use KJV for getting the verse ID
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            // Add filters if specified
            if (bookId) {
                options.params.limitToBookId = bookId.toString().padStart(2, '0');
                if (chapter) {
                    options.params.limitToChapterId = chapter.toString().padStart(3, '0');
                }
            }

            // Fetch random verse
            logger.info(`[RandomVerse Command] Fetching random verse with params:`, options.params);
            const response = await axios.request(options);
            logger.info('[RandomVerse Command] Random verse API response:', JSON.stringify(response.data, null, 2));

            if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
                return interaction.editReply({
                    content: 'Unable to fetch a random verse. Please try again.',
                    ephemeral: true
                });
            }

            // Get the verse data from the response
            const randomVerse = response.data[0];
            const verseId = randomVerse.id;
            const parsedBookId = parseInt(randomVerse.b);
            const parsedChapter = parseInt(randomVerse.c);
            const parsedVerse = parseInt(randomVerse.v);

            // Get verse text from database
            const verseData = await bibleWrapper.getVerses(parsedBookId, parsedChapter, parsedVerse, parsedVerse);
            logger.info('[RandomVerse Command] Database verse data:', JSON.stringify(verseData, null, 2));
            
            if (!verseData || verseData.length === 0) {
                return interaction.editReply({
                    content: 'Error retrieving verse text. Please try again.',
                    ephemeral: true
                });
            }

            // Get verse text from database for the requested translation
            let verseText = verseData[0][translation];
            
            // If the requested translation isn't available, fall back to KJV from the random verse response
            if (!verseText) {
                logger.warn(`[RandomVerse Command] Translation ${translation} not found in database, falling back to KJV`);
                verseText = randomVerse.t;
            }

            logger.info('[RandomVerse Command] Final verse text:', verseText);

            // Create and send embed
            const embed = new EmbedBuilder()
                .setTitle(`${numbersToBook.get(parsedBookId)} ${parsedChapter}:${parsedVerse}`)
                .setDescription(`<**${parsedVerse}**> ${verseText}`)
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter({ 
                    text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`, 
                    iconURL: process.env.EMBEDICONURL 
                });

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            logger.error('[RandomVerse Command] Error:', error);
            
            if (error.response?.status === 404) {
                return interaction.editReply({
                    content: 'No verse found with the specified criteria. Please try again.',
                    ephemeral: true
                });
            }

            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 