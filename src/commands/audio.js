const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const axios = require('axios');
const { getBookId, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

// Constants
const TRANSLATIONS = {
    'King James Version': 'kjv'
};

// Helper functions
function createAudioCommand() {
    const command = new SlashCommandBuilder()
        .setName('audio')
        .setDescription('Get audio narration for a Bible chapter')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book you want to hear')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter you want to hear')
                .setRequired(true));

    return command;
}

function createAudioEmbed(bookId, chapter, version, audioUrl) {
    return new EmbedBuilder()
        .setTitle(`📖 ${numbersToBook.get(bookId)} ${chapter} - Audio Narration`)
        .setDescription(
            `Listen to ${numbersToBook.get(bookId)} chapter ${chapter} in KJV.\n\n` +
            `💻 Audio player is only available on desktop.\n` +
            `📱 Mobile users can [click here to download](${audioUrl})`
        )
        .setColor(eval(process.env.EMBEDCOLOR))
        .setURL(process.env.WEBSITE)
        .setFooter({ 
            text: process.env.EMBEDFOOTERTEXT, 
            iconURL: process.env.EMBEDICONURL 
        })
        .addFields({ 
            name: 'Format', 
            value: 'MP3',
            inline: true 
        });
}

async function fetchAudioNarration(bookId, chapter, version) {
    const options = {
        method: 'GET',
        url: 'https://iq-bible.p.rapidapi.com/GetAudioNarration',
        params: {
            bookId: bookId.toString().padStart(2, '0'),
            chapterId: chapter.toString().padStart(3, '0'),
            versionId: version
        },
        headers: {
            'x-rapidapi-key': process.env.RAPIDAPIKEY,
            'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
        }
    };

    return await axios.request(options);
}

module.exports = {
    data: createAudioCommand(),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            // Get and validate input
            const rawBook = interaction.options.getString('book');
            const chapter = parseInt(interaction.options.getString('chapter'));
            const version = 'kjv'; // Hardcode to KJV

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

            // Fetch audio narration
            logger.info(`[Audio Command] Fetching audio for ${numbersToBook.get(bookId)} ${chapter} (${version.toUpperCase()})`);
            const response = await fetchAudioNarration(bookId, chapter, version);

            if (!response.data?.fileName) {
                return interaction.editReply({
                    content: `No audio narration found for ${numbersToBook.get(bookId)} ${chapter} in ${version.toUpperCase()}.`,
                    ephemeral: true
                });
            }

            // Create attachment and embed
            const audioUrl = response.data.fileName;
            const audioAttachment = new AttachmentBuilder(audioUrl, {
                name: `${numbersToBook.get(bookId)}_${chapter}_${version}.mp3`,
                description: `Audio narration for ${numbersToBook.get(bookId)} ${chapter}`
            });

            const embed = createAudioEmbed(bookId, chapter, version, audioUrl);

            // Send response
            await interaction.editReply({ 
                embeds: [embed],
                files: [audioAttachment]
            });

        } catch (error) {
            logger.error('[Audio Command] Error:', error);
            
            if (error.response?.status === 404) {
                return interaction.editReply({
                    content: `No audio narration available for ${numbersToBook.get(bookId)} ${chapter} in ${version.toUpperCase()}.`,
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