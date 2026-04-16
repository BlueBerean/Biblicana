import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import axios from 'axios';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const API_TIMEOUT_MS = 15000;
const HARDCODED_VERSION = 'kjv';

function createAudioCommand() {
    const command = new SlashCommandBuilder()
        .setName('audio')
        .setDescription('Get audio narration for a Bible chapter (KJV only)')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book name or abbreviation')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true));

    return command;
}

function createAudioEmbed(bookName, chapter, audioUrl) {
    const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;
    return new EmbedBuilder()
        .setTitle(`📖 ${bookName} ${chapter} - Audio Narration (KJV)`)
        .setDescription(
            `Listen to ${bookName} chapter ${chapter} narrated in the King James Version.\n\n` +
            `💻 Audio player is only available on desktop.\n` +
            `📱 Mobile users can [click here to download the MP3](${audioUrl}).`
        )
        .setColor(embedColor)
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
        },
        timeout: API_TIMEOUT_MS
    };

    logger.info(`[Audio Command] Fetching audio with params:`, options.params);
    try {
        const response = await axios.request(options);
        logger.debug("[Audio Command] Raw API Response:", JSON.stringify(response.data));
        return response;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            logger.error(`[Audio Command] API Error: ${error.message}`, {
                status: error.response?.status,
                data: error.response?.data,
                config: error.config
            });
            if (error.code === 'ECONNABORTED') {
                throw new Error(`API request timed out after ${API_TIMEOUT_MS / 1000} seconds.`);
            } else if (error.response?.status) {
                throw new Error(`API returned status ${error.response.status}.`);
            }
        }
        throw new Error(`Failed to fetch audio narration: ${error.message}`);
    }
}

export default {
    data: createAudioCommand(),

    async execute(interaction) {
        await interaction.deferReply();

        let rawBookInput, chapterInput, rawBook, bookId, bookName, chapter, version;

        try {
            rawBookInput = interaction.options.getString('book');
            chapterInput = interaction.options.getString('chapter');
            version = HARDCODED_VERSION;

            rawBook = swearWordFilter(rawBookInput.trim());
            if (!rawBook) {
                return interaction.editReply({ content: 'Please provide a valid book name.', flags: MessageFlags.Ephemeral });
            }

            chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ content: 'Please provide a valid chapter number (1 or greater).', flags: MessageFlags.Ephemeral });
            }

            bookId = getBookId(rawBook);
            bookName = numbersToBook.get(bookId);

            if (!bookId || !bookName) {
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBookInput}". Please check the spelling or use common abbreviations.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const response = await fetchAudioNarration(bookId, chapter, version);

            const audioUrl = response?.data?.fileName;
            if (!audioUrl || typeof audioUrl !== 'string') {
                logger.warn(`[Audio Command] No valid fileName found in API response for ${bookName} ${chapter}`);
                return interaction.editReply({
                    content: `No audio narration found for ${bookName} chapter ${chapter} (KJV). It might not be available.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            try {
                new URL(audioUrl);
            } catch (urlError) {
                logger.error(`[Audio Command] Invalid audio URL received from API: ${audioUrl}`);
                return interaction.editReply({ content: 'Received an invalid audio link from the source.', flags: MessageFlags.Ephemeral });
            }

            let audioAttachment;
            try {
                audioAttachment = new AttachmentBuilder(audioUrl, {
                    name: `${bookName.replace(/ /g, '_')}_${chapter}_${version}.mp3`,
                    description: `Audio narration for ${bookName} chapter ${chapter}`
                });
            } catch (attachmentError) {
                logger.error(`[Audio Command] Failed to create AttachmentBuilder: ${attachmentError.message}`);
                return interaction.editReply({ content: 'Failed to prepare the audio file for sending.', flags: MessageFlags.Ephemeral });
            }

            const embed = createAudioEmbed(bookName, chapter, audioUrl);

            await interaction.editReply({
                embeds: [embed],
                files: [audioAttachment]
            });
            logger.info(`[Audio Command] Successfully sent audio for ${bookName} ${chapter}`);
        } catch (error) {
            const bookDisplay = bookName || rawBookInput || 'the specified book';
            const chapterDisplay = chapter || chapterInput || 'the specified chapter';
            logger.error(`[Audio Command] Error processing request for ${bookDisplay} ${chapterDisplay}: ${error.message}`, error.stack);

            let userErrorMessage = 'Sorry, there was an error processing your request. Please try again later.';
            if (error.message?.includes('status 404') || error.message?.includes('Verse not found')) {
                userErrorMessage = `No audio narration available for ${bookDisplay} chapter ${chapterDisplay} (KJV).`;
            } else if (error.message?.includes('timed out')) {
                userErrorMessage = 'The request to the audio source timed out. Please try again later.';
            }

            try {
                await interaction.editReply({
                    content: `❌ ${userErrorMessage}`,
                    flags: MessageFlags.Ephemeral,
                    embeds: [], files: []
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Audio Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
