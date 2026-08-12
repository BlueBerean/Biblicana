import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { AI_MEMORY_SCOPES } from '../../database/schemas/guild.js';
import {
    saveAiMemoryScope,
    readAiEnabled,
    readAiChannels,
    readAiDeniedRoles,
    buildAiConfigView,
    AI_MEMORY_SCOPE_OPTIONS,
} from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for /config ai's memory-scope dropdown.
// customId: "config:aiscope". Paired with configAi.js (the on/off toggle).
// Re-renders the full config view with BOTH the new scope AND the current
// enabled state preserved, so neither select visually resets the other.
export default {
    id: 'config:aiscope',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:aiscope') return;

        const picked = interaction.values?.[0];
        if (!AI_MEMORY_SCOPES.includes(picked)) {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change AI memory scope.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content: 'AI memory scope is a per-server setting — change it from within a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await saveAiMemoryScope(database, interaction.guildId, picked);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that setting right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = AI_MEMORY_SCOPE_OPTIONS.find(o => o.value === picked)?.label ?? picked;
        try {
            const [currentEnabled, currentChannels, currentDeniedRoles] = await Promise.all([
                readAiEnabled(database, interaction.guildId),
                readAiChannels(database, interaction.guildId),
                readAiDeniedRoles(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({ currentEnabled, currentMemoryScope: picked, currentChannels, currentDeniedRoles }),
            });
            await interaction.followUp({
                content: `✅ Memory scope set to **${pickedLabel}**. Any existing conversation history is untouched — new turns use the new scope.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Config AIScope Select] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
