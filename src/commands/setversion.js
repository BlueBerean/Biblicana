import { SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
import logger from '../utils/logger.js';
import { accentColor, footerLine } from '../utils/theme.js';
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
            // ACK FIRST, before any I/O. Two Neon round-trips follow
            // (getUserValue, then update/set); on a cold endpoint those can
            // exceed Discord's 3-second acknowledgement window, which is how
            // this command became one of the top DiscordAPIError[10062] sources
            // in the prod logs. Nothing below needs to run before the ack, so
            // there is no reason for the ack to sit behind the database.
            await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

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

            // V2 component (matches the rest of the bot's surfaces). The footer
            // is text-only via footerLine() — V2 TextDisplay has no icon field,
            // so no EMBEDICONURL here, unlike the old classic embed.
            const container = new ContainerBuilder()
                .setAccentColor(accentColor())
                .addTextDisplayComponents(new TextDisplayBuilder().setContent('## ✅ Default Translation Set'))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `Your default Bible translation has been set to **${translation}**. Commands like \`/find\` will now use this by default.`
                ))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine()));

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [container],
            });
            logger.info(`[SetVersion Command] Successfully set default translation for ${userName} (${userId}) to ${translation}`);
        } catch (error) {
            logger.error(`[SetVersion Command] Error setting translation for ${userName} (${userId}) to ${translation}: ${error.message}`, error.stack);
            try {
                // The reply was deferred with IsComponentsV2, which locks the
                // response shape to components — a `content` edit is rejected
                // as mutually exclusive, so the error must render as a V2
                // TextDisplay too.
                await interaction.editReply({
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                    components: [new TextDisplayBuilder().setContent(
                        '❌ Sorry, there was an error saving your preference. Please try again later.'
                    )],
                });
            } catch (replyError) {
                if (replyError.code !== 10062 && replyError.code !== 40060) {
                    logger.error(`[SetVersion Command] Failed to send error reply: ${replyError}`);
                }
            }
        }
    },
};
