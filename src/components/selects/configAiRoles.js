import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveAiDeniedRoles,
    readAiEnabled,
    readAiMemoryScope,
    readAiChannels,
    buildAiConfigView,
} from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Handles the RoleSelectMenu that blocks roles from the AI conversation.
// customId "config:ai:roles". interaction.values is the (possibly empty) list of
// blocked role IDs — empty means "clear the denylist → everyone may chat again".
//
// A DENYLIST, unlike the channel ALLOWLIST next to it: empty means unrestricted
// in both cases, but here adding entries takes access away rather than granting
// it. Only gates the @mention/reply conversation; slash commands are governed by
// Discord's own per-command permissions.
export default {
    id: 'config:ai:roles',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:ai:roles') return;

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change AI roles.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'AI chat is a per-server setting — change it from within a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // RoleSelectMenu returns the selected IDs directly; minValues=0 means an
        // empty array is valid and clears the denylist.
        const roleIds = interaction.values ?? [];

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await saveAiDeniedRoles(database, interaction.guildId, roleIds);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const [currentEnabled, currentMemoryScope, currentChannels] = await Promise.all([
                readAiEnabled(database, interaction.guildId),
                readAiMemoryScope(database, interaction.guildId),
                readAiChannels(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({
                    currentEnabled,
                    currentMemoryScope,
                    currentChannels,
                    currentDeniedRoles: roleIds,
                }),
            });

            const confirmation = roleIds.length === 0
                ? '✅ Cleared — **everyone** can use the AI conversation again.'
                : `✅ Blocked from AI chat: ${roleIds.map(id => `<@&${id}>`).join(' ')}. Members with those roles get no response when they mention or reply to Biblicana. Admins with Manage Server are still exempt.\n\n-# Slash commands like \`/find\` and \`/web\` are not affected — restrict those via **Server Settings → Integrations → Biblicana**.`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config AI Roles] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
