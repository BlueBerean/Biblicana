import {
    SlashCommandBuilder,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
} from 'discord.js';
import { readAiMemoryScope } from '../utils/aiConfig.js';
import logger from '../utils/logger.js';

// /forget — wipe the AI conversation memory for the current scope.
// Scope resolution mirrors aiChat.js exactly so /forget always targets the
// SAME key the AI reads/writes:
//   DM                            → dm:<userId>
//   Guild (shared per-channel)    → <guildId>:ch:<channelId>
//   Guild (private per-user)      → <guildId>:usr:<userId>
//
// In shared mode, running /forget in a channel clears the thread for
// everyone who's been chatting in that channel. That's intentional —
// the scope IS the channel. Any admin concern about that belongs in
// /config ai (switch to per-user scope for privacy).
export default {
    data: new SlashCommandBuilder()
        .setName('forget')
        .setDescription('Erase the AI conversation history for this channel.')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction, database) {
        let scopeKey;
        let scopeDescription;
        if (interaction.inGuild()) {
            const memScope = await readAiMemoryScope(database, interaction.guildId);
            if (memScope === 'user') {
                scopeKey = `${interaction.guildId}:usr:${interaction.user.id}`;
                scopeDescription = 'your private conversation in this server';
            } else {
                scopeKey = `${interaction.guildId}:ch:${interaction.channelId}`;
                scopeDescription = "this channel's shared conversation";
            }
        } else {
            scopeKey = `dm:${interaction.user.id}`;
            scopeDescription = 'our DM conversation';
        }

        try {
            const cleared = await database.clearChatMemory(scopeKey);
            if (cleared > 0) {
                logger.info(`[Forget] Cleared chat memory scope=${scopeKey} by user=${interaction.user.id}`);
                await interaction.reply({
                    content: `🗑️ Forgotten. ${scopeDescription.charAt(0).toUpperCase() + scopeDescription.slice(1)} has been erased.`,
                    flags: MessageFlags.Ephemeral,
                });
            } else {
                await interaction.reply({
                    content: `No conversation history to forget for ${scopeDescription}. We're starting fresh anyway.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (err) {
            logger.error(`[Forget] Failed for user=${interaction.user.id}: ${err.message}`);
            try {
                await interaction.reply({
                    content: `⚠️ Couldn't clear memory right now. Try again in a moment.`,
                    flags: MessageFlags.Ephemeral,
                });
            } catch { /* interaction expired */ }
        }
    },
};
