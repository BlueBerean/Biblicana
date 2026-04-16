import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import axios from 'axios';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';
import swearWordFilter from '../utils/filter.js';
import 'dotenv/config';

const API_TIMEOUT_MS = 15000;
const HARDCODED_VERSION = 'kjv';

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

    logger.info(`[Audio Command] Fetching audio:`, options.params);
    const response = await axios.request(options);
    return response;
}

function buildAudioResponse({ bookId, bookName, chapter, audioUrl }) {
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 🔊 ${bookName} ${chapter} — Audio Narration (KJV)`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `Listen to ${bookName} chapter ${chapter} narrated in the King James Version.\n\n💻 Audio player appears inline on desktop. 📱 Mobile users: tap **Download MP3** below.`
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | MP3 format`
        ));

    // Row 1 — in-app actions routed through openverse
    const inAppRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:chapter:${bookId}:${chapter}:1`)
            .setLabel('Open chapter')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            // verse=0 sentinel tells the commentary handler to pull the chapter introduction
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:0`)
            .setLabel('Chapter Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary)
    );

    // Row 2 — external link (MP3 download). Link buttons need no custom_id.
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Download MP3')
            .setEmoji({ name: '⬇️' })
            .setStyle(ButtonStyle.Link)
            .setURL(audioUrl)
    );

    return [container, inAppRow, linkRow];
}

export default {
    data: new SlashCommandBuilder()
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
                .setRequired(true)),

    async execute(interaction) {
        const rawBookInput = interaction.options.getString('book');
        const chapterInput = interaction.options.getString('chapter');

        const rawBook = swearWordFilter(rawBookInput.trim());
        if (!rawBook) {
            return interaction.reply({ content: 'Please provide a valid book name.', flags: MessageFlags.Ephemeral });
        }

        const chapter = parseInt(chapterInput);
        if (isNaN(chapter) || chapter < 1) {
            return interaction.reply({ content: 'Please provide a valid chapter number (1 or greater).', flags: MessageFlags.Ephemeral });
        }

        const bookId = getBookId(rawBook);
        const bookName = numbersToBook.get(bookId);
        if (!bookId || !bookName) {
            return interaction.reply({
                content: `I couldn't find the book "${rawBookInput}". Please check the spelling or use common abbreviations.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const response = await fetchAudioNarration(bookId, chapter, HARDCODED_VERSION);
            const audioUrl = response?.data?.fileName;

            if (!audioUrl || typeof audioUrl !== 'string') {
                logger.warn(`[Audio Command] No valid fileName in API response for ${bookName} ${chapter}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No audio narration found for ${bookName} chapter ${chapter} (KJV). It might not be available.`
                    )]
                });
            }

            try {
                new URL(audioUrl);
            } catch (urlError) {
                logger.error(`[Audio Command] Invalid audio URL: ${audioUrl}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Received an invalid audio link from the source.`)]
                });
            }

            const audioAttachment = new AttachmentBuilder(audioUrl, {
                name: `${bookName.replace(/ /g, '_')}_${chapter}_${HARDCODED_VERSION}.mp3`,
                description: `Audio narration for ${bookName} chapter ${chapter}`
            });

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAudioResponse({ bookId, bookName, chapter, audioUrl }),
                files: [audioAttachment]
            });
            logger.info(`[Audio Command] Sent audio for ${bookName} ${chapter}`);
        } catch (error) {
            const bookDisplay = bookName || rawBookInput || 'the specified book';
            const chapterDisplay = chapter || chapterInput || 'the specified chapter';
            logger.error(`[Audio Command] Error for ${bookDisplay} ${chapterDisplay}: ${error.message}`, error.stack);

            let userErrorMessage = 'Sorry, there was an error processing your request. Please try again later.';
            if (error.message?.includes('status 404') || error.message?.includes('Verse not found')) {
                userErrorMessage = `No audio narration available for ${bookDisplay} chapter ${chapterDisplay} (KJV).`;
            } else if (error.code === 'ECONNABORTED' || error.message?.includes('timed out')) {
                userErrorMessage = 'The request to the audio source timed out. Please try again later.';
            }

            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ ${userErrorMessage}`)]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[Audio Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    }
};
