import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import { bibleWrapper, numbersToBook, getBookId } from '../utils/bibleHelper.js';
import logger from '../utils/logger.js';

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
        await interaction.deferReply();

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';

            const rawBook = interaction.options.getString('book').split(" ").join("");
            logger.info(`[Bible Command] Raw book input: ${rawBook}`);

            const bookid = getBookId(rawBook);
            logger.info(`[Bible Command] Book ID lookup result: ${bookid}`);

            if (!bookid) {
                logger.warn(`[Bible Command] Could not find book ID for: ${rawBook}`);
                return interaction.editReply({
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const chapter = interaction.options.getString('chapter');
            const startVerse = interaction.options.getNumber('startverse');
            const endVerse = interaction.options.getNumber('endverse') || startVerse;

            logger.info(`[Bible Command] Looking up book ${bookid} (${numbersToBook.get(bookid)}) ${chapter}:${startVerse}-${endVerse} in ${translation}`);

            if (startVerse > endVerse) {
                return interaction.editReply({ content: 'The start verse cannot be greater than the end verse', flags: MessageFlags.Ephemeral });
            }

            let verses = await bibleWrapper.getVerses(bookid, chapter, startVerse, endVerse, translation);

            if (!verses.length > 0) {
                return interaction.editReply({
                    content: `I couldn't find any verses related to ${numbersToBook.get(bookid)} ${chapter}:${startVerse}${endVerse && startVerse != endVerse ? "-" + endVerse : ""}!`,
                    flags: MessageFlags.Ephemeral
                });
            }

            verses.sort((a, b) => a.verse - b.verse);

            let response = "";
            for (let i = 0; i < verses.length; i++) {
                let number = i + startVerse;

                if (response.length > 1) {
                    response += " ";
                }

                if (response.length + verses[i][translation].length > 1900) {
                    response = "**The response was too long! Please try again with a smaller range of verses. Here is all I can post:**\n\n" + response;
                    break;
                }

                response += "<**" + number + "**> " + verses[i][translation];
            }

            let embed = new EmbedBuilder()
                .setTitle(`${numbersToBook.get(bookid)} ${chapter}:${startVerse}${endVerse && startVerse != endVerse ? "-" + endVerse : ""}`)
                .setDescription(response)
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter({
                    text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`,
                    iconURL: process.env.EMBEDICONURL
                });

            return interaction.editReply({ embeds: [embed] });
        } catch (error) {
            logger.error(`[Bible Command] Error processing request: ${error.message}`);
            logger.error(error.stack);

            try {
                return interaction.editReply({
                    content: 'Sorry, there was an error processing your request.',
                    flags: MessageFlags.Ephemeral
                });
            } catch (e) {
                logger.error(`[Bible Command] Could not send error message: ${e.message}`);
            }
        }
    },
};
