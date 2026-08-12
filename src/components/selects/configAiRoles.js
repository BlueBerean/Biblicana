import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveAiDeniedRoles,
    readAiEnabled,
    readAiMemoryScope,
    readAiChannels,
    readAiRequiredRoles,
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
            // Re-read EVERY other setting, required roles included. Omitting one
            // here doesn't lose it from the database, but the re-rendered panel
            // would show it as unset — an admin reading "Who can use it:
            // Everyone" right after blocking a role would reasonably believe
            // their requirement had just been cleared.
            const [currentEnabled, currentMemoryScope, currentChannels, currentRequiredRoles] = await Promise.all([
                readAiEnabled(database, interaction.guildId),
                readAiMemoryScope(database, interaction.guildId),
                readAiChannels(database, interaction.guildId),
                readAiRequiredRoles(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({
                    currentEnabled,
                    currentMemoryScope,
                    currentChannels,
                    currentDeniedRoles: roleIds,
                    currentRequiredRoles,
                }),
            });

            // Mirror of the note in configAiRequiredRoles.js — name the overlap
            // from whichever picker the admin happens to be standing in.
            const overlapNote = (roleIds.length > 0 && currentRequiredRoles.length > 0)
                ? '\n\n-# This overrules the required roles — someone holding both gets no response.'
                : '';
            const confirmation = roleIds.length === 0
                ? (currentRequiredRoles.length > 0
                    ? '✅ Cleared — nobody is blocked. AI chat is still limited to the required roles.'
                    : '✅ Cleared — **everyone** can use the AI conversation again.')
                : `✅ Blocked from AI chat: ${roleIds.map(id => `<@&${id}>`).join(' ')}. Members with those roles get no response when they mention or reply to Biblicana. Admins with Manage Server are still exempt.${overlapNote}\n\n-# Slash commands like \`/find\` and \`/web\` are not affected — restrict those via **Server Settings → Integrations → Biblicana**.`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config AI Roles] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
