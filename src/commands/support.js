import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
} from 'discord.js';
import { accentColor, footerLine, SUPPORT_INVITE, PRIVACY_URL, TERMS_URL } from '../utils/theme.js';

// /support — surfaces the Biblicana support server invite + /help pointer.
// Ephemeral so it doesn't clutter the channel when someone needs help.
// Available in DMs and via user-install (per Integration Types), since the
// most likely use case is "this bot isn't doing what I expect, where do I ask".
export default {
    data: new SlashCommandBuilder()
        .setName('support')
        .setDescription('Join the Biblicana support server, or find help.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction) {
        const container = new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent('## 🆘 Biblicana Support'))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                [
                    `**Support server**: ${SUPPORT_INVITE}`,
                    'Ask questions, report bugs, suggest features, or chat with other users.',
                    '',
                    `**Commands**: \`/help\` shows every slash command Biblicana offers.`,
                    `**Server settings**: admins can configure passive detection, AI chat, and daily verse with \`/config\`.`,
                    '',
                    `**Legal**: [Privacy Policy](${PRIVACY_URL}) · [Terms of Service](${TERMS_URL})`,
                ].join('\n')
            ))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine('Biblicana · Bible study for Discord')
            ));

        await interaction.reply({
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
        });
    },
};
