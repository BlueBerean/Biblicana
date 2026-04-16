import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import { createRequire } from 'node:module';
import logger from '../utils/logger.js';
import { bibleWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const VOTDData = require('../../data/VOTD.json');

const MAX_BODY_CHARS = 3800;

function parseVOTDReference(refString) {
    if (!refString) return null;
    const match = refString.match(/^([1-3]?\s*[\w\s]+?)\s+(\d+):(\d+)(?:-(\d+))?$/i);
    if (!match) return null;
    const bookId = getBookId(match[1].trim());
    if (!bookId) return null;
    const chapter = parseInt(match[2]);
    const startVerse = parseInt(match[3]);
    const endVerse = match[4] ? parseInt(match[4]) : startVerse;
    if (isNaN(chapter) || isNaN(startVerse) || isNaN(endVerse)) return null;
    return { bookId, chapter, startVerse, endVerse };
}

function buildPassageOfTheDayResponse({ bookId, bookName, chapter, startVerse, endVerse, body, translation, dateString }) {
    const rangeLabel = endVerse > startVerse
        ? `${bookName} ${chapter}:${startVerse}-${endVerse}`
        : `${bookName} ${chapter}:${startVerse}`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📅 Daily Passage — ${dateString}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### ${rangeLabel}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(`Translation: ${translation.toUpperCase()}`)
        ));

    // Action row: Open passage (range-aware), plus per-verse chain actions on startVerse.
    const openCustomId = endVerse > startVerse
        ? `openverse:bible:${bookId}:${chapter}:${startVerse}:${endVerse}`
        : `openverse:bible:${bookId}:${chapter}:${startVerse}`;

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(openCustomId)
            .setLabel('Open')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${bookId}:${chapter}:${startVerse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary)
    );

    return [container, actionRow];
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
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

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
                logger.error(`[PassageOfTheDay Command] No reference for ${monthName} ${dayOfMonth}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't find today's passage in the schedule.`
                    )]
                });
            }

            logger.info(`[PassageOfTheDay Command] Today's reference: ${referenceString}`);
            const parsedRef = parseVOTDReference(referenceString);

            if (!parsedRef) {
                logger.error(`[PassageOfTheDay Command] Failed to parse: ${referenceString}`);
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't parse today's passage reference.`
                    )]
                });
            }

            const { bookId, chapter, startVerse, endVerse } = parsedRef;
            const bookName = numbersToBook.get(bookId);

            const verses = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);
            if (!verses || verses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Couldn't fetch text for today's passage (${bookName} ${chapter}:${startVerse}-${endVerse}).`
                    )]
                });
            }

            verses.sort((a, b) => a.verse - b.verse);

            let body = '';
            let truncated = false;
            for (const v of verses) {
                const text = v[translation];
                if (!text) continue;
                const chunk = (body ? ' ' : '') + (startVerse === endVerse ? text : `**${v.verse}** ${text}`);
                if (body.length + chunk.length > MAX_BODY_CHARS) {
                    truncated = true;
                    break;
                }
                body += chunk;
            }
            if (!body) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ No text available for today's passage in ${translation.toUpperCase()}.`
                    )]
                });
            }
            if (truncated) body += '\n\n*Truncated.*';

            const dateString = today.toLocaleDateString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            });

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPassageOfTheDayResponse({
                    bookId, bookName, chapter, startVerse, endVerse, body, translation, dateString
                })
            });
        } catch (error) {
            logger.error(`[PassageOfTheDay Command] Unhandled error: ${error.message}`, error.stack);
            try {
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(
                        `❌ Sorry, there was an unexpected error processing your request.`
                    )]
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[PassageOfTheDay Command] Failed to send final error reply: ${replyError}`);
                }
            }
        }
    }
};
