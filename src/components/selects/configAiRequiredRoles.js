import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveAiRequiredRoles,
    readAiEnabled,
    readAiMemoryScope,
    readAiChannels,
    readAiDeniedRoles,
    buildAiConfigView,
} from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Handles the RoleSelectMenu that RESTRICTS the AI conversation to specific
// roles. customId "config:ai:reqroles". interaction.values is the (possibly
// empty) list of required role IDs — empty means "clear the requirement →
// everyone may chat again".
//
// Sibling of configAiRoles.js (the denylist). Both are role pickers, but they
// pull in opposite directions: this one grants, that one takes away, and the
// denylist wins where they overlap.
export default {
    id: 'config:ai:reqroles',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:ai:reqroles') return;

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

        const roleIds = interaction.values ?? [];

        // ACK FIRST — see configDailyEnabled.js for the full rationale.
        await interaction.deferUpdate();

        const saved = await saveAiRequiredRoles(database, interaction.guildId, roleIds);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const [currentEnabled, currentMemoryScope, currentChannels, currentDeniedRoles] = await Promise.all([
                readAiEnabled(database, interaction.guildId),
                readAiMemoryScope(database, interaction.guildId),
                readAiChannels(database, interaction.guildId),
                readAiDeniedRoles(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({
                    currentEnabled,
                    currentMemoryScope,
                    currentChannels,
                    currentDeniedRoles,
                    currentRequiredRoles: roleIds,
                }),
            });

            // Name the overlap explicitly when both lists are set — it is the
            // one part of the combined behaviour an admin can get wrong.
            const overlapNote = (roleIds.length > 0 && currentDeniedRoles.length > 0)
                ? '\n\n-# A blocked role still overrules this — someone holding both gets no response.'
                : '';
            const confirmation = roleIds.length === 0
                ? '✅ Cleared — the AI conversation is open to **everyone** again (except any blocked roles).'
                : `✅ AI chat now limited to: ${roleIds.map(id => `<@&${id}>`).join(' ')}. Everyone else gets no response when they mention or reply to Biblicana. Admins with Manage Server are exempt.${overlapNote}`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config AI Required Roles] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
