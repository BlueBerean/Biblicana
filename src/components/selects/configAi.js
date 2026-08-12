import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { saveAiEnabled, readAiMemoryScope, readAiChannels, readAiDeniedRoles, readAiRequiredRoles, buildAiConfigView, AI_OPTIONS } from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for the compact /config ai panel. customId:
// "config:ai". Same persistence as welcomeAi, different render target —
// updates the ephemeral /config ai message rather than the public welcome
// card.
export default {
    id: 'config:ai',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:ai') return;

        const picked = interaction.values?.[0];
        if (picked !== 'on' && picked !== 'off') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change AI chat.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content: 'AI chat is a per-server setting — change it from within a server.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const enabled = picked === 'on';
        const saved = await saveAiEnabled(database, interaction.guildId, enabled);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that setting right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = AI_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const [currentMemoryScope, currentChannels, currentDeniedRoles, currentRequiredRoles] = await Promise.all([
                readAiMemoryScope(database, interaction.guildId),
                readAiChannels(database, interaction.guildId),
                readAiDeniedRoles(database, interaction.guildId),
                readAiRequiredRoles(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildAiConfigView({ currentEnabled: enabled, currentMemoryScope, currentChannels, currentDeniedRoles, currentRequiredRoles }),
            });
            await interaction.followUp({
                content: enabled
                    ? `✅ **${pickedLabel}** — I'll respond when mentioned or replied to. Use \`/forget\` anytime to erase chat history.`
                    : `✅ **${pickedLabel}** — mentions and replies will be ignored. Slash commands still work.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Config AI Select] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
