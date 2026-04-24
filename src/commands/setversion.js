import { SlashCommandBuilder, EmbedBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import logger from '../utils/logger.js';
import { accentColor } from '../utils/theme.js';
import 'dotenv/config';

export default {
    data: new SlashCommandBuilder()
        .setName('setversion')
        .setDescription('Set your preferred default Bible translation.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('Your preferred translation')
                .setRequired(true)
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: 'KJV', value: 'KJV' },
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
        const translation = interaction.options.getString('translation');
        const userId = interaction.user.id;
        const userName = interaction.user.username;

        try {
            logger.info(`[SetVersion Command] User ${userName} (${userId}) attempting to set default translation to ${translation}`);

            const userExists = await database.getUserValue(userId);

            let dbOperationSuccessful;
            if (userExists) {
                logger.debug(`[SetVersion Command] Updating existing user ${userId}`);
                dbOperationSuccessful = await database.updateUserValue(userId, { translation });
            } else {
                logger.debug(`[SetVersion Command] Inserting new user ${userId}`);
                dbOperationSuccessful = await database.setUserValue(userId, { id: userId, translation });
            }

            if (!dbOperationSuccessful && dbOperationSuccessful !== undefined) {
                throw new Error('Database operation returned unsuccessful status.');
            }

            let embed = new EmbedBuilder()
                .setTitle('✅ Default Translation Set')
                .setDescription(`Your default Bible translation has been set to **${translation}**. Commands like \`/find\` will now use this by default.`)
                .setColor(accentColor())
                .setURL(process.env.WEBSITE)
                .setFooter({
                    text: process.env.EMBEDFOOTERTEXT,
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            logger.info(`[SetVersion Command] Successfully set default translation for ${userName} (${userId}) to ${translation}`);
        } catch (error) {
            logger.error(`[SetVersion Command] Error setting translation for ${userName} (${userId}) to ${translation}: ${error.message}`, error.stack);
            try {
                await interaction.reply({
                    content: '❌ Sorry, there was an error saving your preference. Please try again later.',
                    flags: MessageFlags.Ephemeral
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[SetVersion Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    },
};
