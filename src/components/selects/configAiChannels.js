import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveAiChannels,
    readAiEnabled,
    readAiMemoryScope,
    readAiDeniedRoles,
    buildAiConfigView,
} from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Handles the ChannelSelectMenu that restricts where AI chat may respond.
// customId "config:ai:channels". interaction.values is the (possibly empty)
// list of allowed channel IDs — empty means "clear the allowlist → allow the
// AI conversation in every channel again". Only gates the @mention/reply
// conversation; slash commands are never affected.
export default {
    id: 'config:ai:channels',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:ai:channels') return;

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change AI channels.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'AI chat is a per-server setting — change it from within a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ChannelSelectMenu returns the selected IDs directly; minValues=0 means
        // an empty array is valid and clears the restriction.
        const channelIds = interaction.values ?? [];

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await saveAiChannels(database, interaction.guildId, channelIds);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const [currentEnabled, currentMemoryScope, currentDeniedRoles] = await Promise.all([
                readAiEnabled(database, interaction.guildId),
                readAiMemoryScope(database, interaction.guildId),
                readAiDeniedRoles(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({ currentEnabled, currentMemoryScope, currentChannels: channelIds, currentDeniedRoles }),
            });

            const confirmation = channelIds.length === 0
                ? '✅ Cleared — the AI conversation is now allowed in **all channels**.'
                : `✅ The AI conversation is now limited to: ${channelIds.map(id => `<#${id}>`).join(' ')}. It stays silent in other channels. Slash commands still work everywhere.`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config AI Channels] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
