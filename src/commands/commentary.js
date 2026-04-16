import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import axios from 'axios';
import logger from '../utils/logger.js';
import splitString from '../utils/splitString.js';
import { getBookId, numbersToBook } from '../utils/bibleHelper.js';
import 'dotenv/config';

const MAX_CHARS_PER_CHUNK = 4000;
const COLLECTOR_TIMEOUT_MS = 1_800_000;

function generateFooter(page, maxPages) {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Page ${page + 1}/${maxPages}`,
        iconURL: process.env.EMBEDICONURL
    };
}

const createActionRow = (currentPage, totalPages, isEnd = false) => new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji('◀️')
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji('▶️')
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(isEnd || currentPage === totalPages - 1)
    );

function cleanCommentary(text) {
    if (typeof text !== 'string') {
        text = JSON.stringify(text);
    }
    return text
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\{[^}]+\}/g, '')
        .replace(/T\.\s*Bab\.\s*[^,]+\s*(?:fol\.|\.)\s*\d+(\.\d+)?/g, '')
        .replace(/\([^)]*\b(?:Ibid|See|Compare|Cf)\b[^)]*\)/gi, '')
        .replace(/\([^)]+\)$/gm, '')
        .replace(/(\r\n|\n|\r)/gm, " ")
        .replace(/\s{2,}/g, ' ')
        .trim();
}

export default {
    data: new SlashCommandBuilder()
        .setName('commentary')
        .setDescription("Look up Gill's Bible Commentary for a specific verse")
        .addStringOption(option =>
            option.setName('book')
                .setDescription('The book you want to find commentary for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('The verse number')
                .setRequired(true)
                .setMinValue(1)),

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const rawBook = interaction.options.getString('book');
            const chapterInput = interaction.options.getString('chapter');
            const verseInput = interaction.options.getNumber('verse');

            const chapter = parseInt(chapterInput);
            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({
                    content: 'Please provide a valid chapter number (must be 1 or greater).',
                    ephemeral: true
                });
            }

            if (verseInput === null || !Number.isInteger(verseInput) || verseInput < 1) {
                return interaction.editReply({
                    content: 'Please provide a valid verse number (must be a whole number, 1 or greater).',
                    ephemeral: true
                });
            }
            const verse = verseInput;

            const bookId = getBookId(rawBook);
            const bookName = numbersToBook.get(bookId);
            if (!bookId) {
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                    ephemeral: true
                });
            }

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}`;
            logger.info(`[Commentary Command] Looking up commentary for ${bookName} ${chapter}:${verse} (ID: ${verseId})`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetCommentary',
                params: {
                    commentaryName: 'gills',
                    verseId: verseId
                },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const response = await axios.request(options);

            if (!response.data) {
                return interaction.editReply(`No commentary found for ${bookName} ${chapter}:${verse}.`);
            }

            const cleanedCommentary = cleanCommentary(response.data);

            if (!cleanedCommentary) {
                return interaction.editReply(`The commentary for ${bookName} ${chapter}:${verse} appears to be empty after cleaning.`);
            }

            const commentaryText = `*From Gill's Exposition of the Bible*\n\n${cleanedCommentary}`;

            const chunks = splitString(commentaryText, MAX_CHARS_PER_CHUNK);

            if (chunks.length === 0) {
                return interaction.editReply(`Failed to process commentary for ${bookName} ${chapter}:${verse}.`);
            }

            let currentPageIndex = 0;

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setColor(embedColor)
                .setTitle(`📖 Gill's Commentary: ${bookName} ${chapter}:${verse}`)
                .setDescription(chunks[currentPageIndex])
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(currentPageIndex, chunks.length));

            if (chunks.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            const message = await interaction.editReply({
                embeds: [embed],
                components: [createActionRow(currentPageIndex, chunks.length)]
            });

            const filter = i => i.user.id === interaction.user.id;

            const collector = message.createMessageComponentCollector({
                filter,
                componentType: ComponentType.Button,
                time: COLLECTOR_TIMEOUT_MS
            });

            collector.on('collect', async i => {
                try {
                    await i.deferUpdate();

                    if (i.customId === 'page_next') {
                        currentPageIndex = (currentPageIndex + 1) % chunks.length;
                    } else if (i.customId === 'page_back') {
                        currentPageIndex = (currentPageIndex - 1 + chunks.length) % chunks.length;
                    }

                    embed.setDescription(chunks[currentPageIndex])
                        .setFooter(generateFooter(currentPageIndex, chunks.length));

                    await i.editReply({
                        embeds: [embed],
                        components: [createActionRow(currentPageIndex, chunks.length)]
                    });
                } catch (collectError) {
                    logger.error(`[Commentary Command] Error updating pagination: ${collectError}`);
                    try {
                        await i.followUp({ content: 'There was an error changing the page.', ephemeral: true });
                    } catch (followUpError) {
                        logger.error(`[Commentary Command] Error sending follow-up after pagination error: ${followUpError}`);
                    }
                }
            });

            collector.on('end', () => {
                logger.info(`[Commentary Command] Pagination collector ended for ${bookName} ${chapter}:${verse}`);
                const timedOutRow = createActionRow(currentPageIndex, chunks.length, true);
                message.edit({ components: [timedOutRow] }).catch(editError => {
                    logger.error(`[Commentary Command] Error disabling buttons after timeout: ${editError}`);
                });
            });
        } catch (error) {
            logger.error(`[Commentary Command] Error: ${error.message}`, error.stack);
            if (error.response) {
                logger.error(`[Commentary Command] API Error Status: ${error.response.status}`);
                logger.error(`[Commentary Command] API Error Data: ${JSON.stringify(error.response.data)}`);
            }
            try {
                await interaction.editReply({
                    content: 'Sorry, there was an error fetching or processing the commentary. Please check the book/chapter/verse or try again later.',
                    ephemeral: true
                });
            } catch (replyError) {
                logger.error(`[Commentary Command] Failed to send error reply: ${replyError}`);
            }
        }
    },
};
