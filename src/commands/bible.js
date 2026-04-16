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
import { bibleWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';

const MAX_BODY_CHARS = 3800;

function buildVerseActionRow(bookId, chapter, verse) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${bookId}:${chapter}:${verse}`)
            .setLabel('Interlinear')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${bookId}:${chapter}:${verse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${bookId}:${chapter}:${verse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${bookId}:${chapter}:${verse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary)
    );
}

export default {
    data: new SlashCommandBuilder()
        .setName('bible')
        .setDescription('Find a specific verse in the bible')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option => option.setName('book').setDescription('The book you want to find a verse for').setRequired(true))
        .addStringOption(option => option.setName('chapter').setDescription('The chapter you want to find a verse for').setRequired(true))
        .addNumberOption(option => option.setName('startverse').setDescription('The range of verses you want to find').setRequired(true))
        .addNumberOption(option => option.setName('endverse').setDescription('The range of verses you want to find'))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),

    async execute(interaction, database) {
        const rawBook = interaction.options.getString('book').split(" ").join("");
        logger.info(`[Bible Command] Raw book input: ${rawBook}`);

        const bookId = getBookId(rawBook);
        logger.info(`[Bible Command] Book ID lookup result: ${bookId}`);

        if (!bookId) {
            logger.warn(`[Bible Command] Could not find book ID for: ${rawBook}`);
            return interaction.reply({
                content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                flags: MessageFlags.Ephemeral
            });
        }

        const chapter = interaction.options.getString('chapter');
        const startVerse = interaction.options.getNumber('startverse');
        const endVerse = interaction.options.getNumber('endverse') || startVerse;

        if (startVerse > endVerse) {
            return interaction.reply({
                content: 'The start verse cannot be greater than the end verse.',
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            const bookName = numbersToBook.get(bookId);
            const rangeLabel = endVerse !== startVerse
                ? `${bookName} ${chapter}:${startVerse}-${endVerse}`
                : `${bookName} ${chapter}:${startVerse}`;

            logger.info(`[Bible Command] Looking up ${bookId} (${bookName}) ${chapter}:${startVerse}-${endVerse} in ${translation}`);

            const verses = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse, translation);

            if (!verses || verses.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ I couldn't find any verses for ${rangeLabel}!`)]
                });
            }

            verses.sort((a, b) => a.verse - b.verse);

            let body = '';
            let truncated = false;
            for (let i = 0; i < verses.length; i++) {
                const verseNum = verses[i].verse;
                const text = verses[i][translation];
                if (!text) continue;

                const nextChunk = (body ? ' ' : '') + `**${verseNum}** ${text}`;
                if (body.length + nextChunk.length > MAX_BODY_CHARS) {
                    truncated = true;
                    break;
                }
                body += nextChunk;
            }

            if (!body) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ No text available for ${rangeLabel} in ${translation.toUpperCase()}.`)]
                });
            }

            if (truncated) {
                body += '\n\n*Truncated — try a smaller range.*';
            }

            const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;
            const footer = `${process.env.EMBEDFOOTERTEXT || ''} | Translation: ${translation.toUpperCase()}`.trim();

            const container = new ContainerBuilder()
                .setAccentColor(accentColor)
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${rangeLabel}`))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));

            const components = [container];

            // Only attach action buttons for single-verse lookups — range lookups
            // have no single verse to run commentary/crossref/etc. against.
            if (startVerse === endVerse) {
                components.push(buildVerseActionRow(bookId, chapter, startVerse));
            }

            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components
            });
        } catch (error) {
            logger.error(`[Bible Command] Error processing request: ${error.message}`);
            logger.error(error.stack);

            try {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: [new TextDisplayBuilder().setContent(`❌ Sorry, there was an error processing your request.`)]
                });
            } catch (e) {
                logger.error(`[Bible Command] Could not send error message: ${e.message}`);
            }
        }
    },
};
