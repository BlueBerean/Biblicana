import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { AI_MEMORY_SCOPES } from '../../database/schemas/guild.js';
import {
    saveAiMemoryScope,
    readAiEnabled,
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

        const saved = await saveAiMemoryScope(database, interaction.guildId, picked);
        if (!saved) {
            return interaction.reply({
                content: '⚠️ Could not save that setting right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = AI_MEMORY_SCOPE_OPTIONS.find(o => o.value === picked)?.label ?? picked;
        try {
            const currentEnabled = await readAiEnabled(database, interaction.guildId);
            await interaction.update({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({ currentEnabled, currentMemoryScope: picked }),
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
