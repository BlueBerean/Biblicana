import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { createRequire } from 'node:module';
import logger from '../utils/logger.js';
import { bibleWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const VOTDData = require('../../data/VOTD.json');

const VERSE_FETCH_TIMEOUT_MS = 6000;

function generateFooter(translation = "BSB") {
    return {
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()}`,
        iconURL: process.env.EMBEDICONURL
    };
}

function parseVOTDReference(refString) {
    if (!refString) return null;

    const match = refString.match(/^([1-3]?\s*[\w\s]+)\s+(\d+):(\d+)(?:-(\d+))?$/i);

    if (!match) {
        logger.warn(`[parseVOTDReference] Could not parse reference string: ${refString}`);
        return null;
    }

    const bookNameStr = match[1].trim();
    const chapterStr = match[2];
    const startVerseStr = match[3];
    const endVerseStr = match[4];

    const bookId = getBookId(bookNameStr);
    if (!bookId) {
        logger.warn(`[parseVOTDReference] Could not get bookId for book name: ${bookNameStr}`);
        return null;
    }

    const chapter = parseInt(chapterStr);
    const startVerse = parseInt(startVerseStr);
    const endVerse = endVerseStr ? parseInt(endVerseStr) : startVerse;

    if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) {
        logger.warn(`[parseVOTDReference] Failed to parse chapter/verse numbers in: ${refString}`);
        return null;
    }

    return { bookId, chapter, startVerse, endVerse };
}

export default {
    data: new SlashCommandBuilder()
        .setName('passageoftheday')
        .setDescription('Get the Bible passage selected for today')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show the passage in (defaults to BSB)')
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
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) translation = userPref.translation;
            } catch (dbError) {
                logger.error(`[PassageOfTheDay Command] Failed to get user preference: ${dbError}`);
            }
            translation = interaction.options.getString('translation') || translation;

            const today = new Date();
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            const monthName = monthNames[today.getMonth()];
            const dayOfMonth = today.getDate().toString();

            const referenceString = VOTDData?.[monthName]?.[dayOfMonth];

            if (!referenceString) {
                logger.error(`[PassageOfTheDay Command] No reference found in VOTD.json for ${monthName} ${dayOfMonth}`);
                return interaction.editReply({ content: 'Sorry, could not find today\'s passage in the schedule.', flags: MessageFlags.Ephemeral });
            }

            logger.info(`[PassageOfTheDay Command] Today's reference from JSON: ${referenceString}`);

            const parsedRef = parseVOTDReference(referenceString);

            if (!parsedRef) {
                logger.error(`[PassageOfTheDay Command] Failed to parse reference string: ${referenceString}`);
                return interaction.editReply({ content: 'Sorry, there was an error understanding today\'s passage reference.', flags: MessageFlags.Ephemeral });
            }

            const { bookId, chapter, startVerse, endVerse } = parsedRef;
            const bookName = numbersToBook.get(bookId);

            let verseTextResult;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), VERSE_FETCH_TIMEOUT_MS);
                verseTextResult = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!verseTextResult || verseTextResult.length === 0) {
                    throw new Error('No verses returned from bibleWrapper');
                }
            } catch (fetchError) {
                logger.error(`[PassageOfTheDay Command] Error fetching verse text for ${bookName} ${chapter}:${startVerse}-${endVerse}: ${fetchError}`);
                return interaction.editReply({ content: 'Sorry, I couldn\'t fetch the text for today\'s passage.', flags: MessageFlags.Ephemeral });
            }

            let formattedVerseText = "";
            let referenceDisplay = "";
            if (startVerse === endVerse) {
                referenceDisplay = `${bookName} ${chapter}:${startVerse}`;
                formattedVerseText = verseTextResult[0]?.[translation] || '(Translation not available)';
            } else {
                referenceDisplay = `${bookName} ${chapter}:${startVerse}-${endVerse}`;
                formattedVerseText = verseTextResult.map(v => `**${v.verse}** ${v[translation] || '(Translation missing)'}`).join(' ');
            }

            const MAX_DESC_LENGTH = 4000;
            if (formattedVerseText.length > MAX_DESC_LENGTH) {
                formattedVerseText = formattedVerseText.substring(0, MAX_DESC_LENGTH - 3) + '...';
            }

            const dateString = today.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x0099FF;

            const embed = new EmbedBuilder()
                .setTitle(`📖 Daily Bible Passage - ${dateString}`)
                .setDescription(`### ${referenceDisplay}\n\n*${formattedVerseText}*`)
                .setColor(embedColor)
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation));

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logger.error(`[PassageOfTheDay Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    content: '❌ Sorry, there was an unexpected error processing your request.',
                    flags: MessageFlags.Ephemeral,
                    embeds: [], components: []
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[PassageOfTheDay Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
