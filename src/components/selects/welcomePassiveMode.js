import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { PASSIVE_MODES } from '../../database/schemas/guild.js';
import { buildWelcomeCard, PASSIVE_MODE_OPTIONS } from '../../utils/welcomeCard.js';
import { savePassiveMode } from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Welcome-card passive-mode selector. customId: "welcome:passive".
// Dispatched by src/events/interactionCreate.js via the selects registry.
//
// Gating: only admins (ManageGuild permission) can change this setting, but
// the select is rendered for everyone so the card doesn't need a permission-
// aware render pass. Non-admins who interact get an ephemeral refusal and
// the card re-renders unchanged (interaction.update restores the previous
// selected-default state).
export default {
    id: 'welcome:passive',
    async execute(interaction, database) {
        // Exact-match dispatch; guard is belt-and-suspenders.
        if (interaction.customId !== 'welcome:passive') return;

        const picked = interaction.values?.[0];
        if (!PASSIVE_MODES.includes(picked)) {
            return interaction.reply({ content: 'Unknown mode.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change passive detection mode.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (!interaction.guildId) {
            return interaction.reply({
                content: 'Passive detection is a per-server setting — this has no effect in DMs.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + getGuildValue below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await savePassiveMode(database, interaction.guildId, picked);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that setting right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = PASSIVE_MODE_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            // Re-render the card so the select visually reflects the new default.
            // Also read the current aiEnabled so the AI select doesn't reset
            // to its default when only the passive select was touched.
            const existing = await database.getGuildValue(interaction.guildId) ?? {};
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildWelcomeCard({
                    currentPassiveMode: picked,
                    currentAiEnabled: Boolean(existing.aiEnabled),
                    currentDailyEnabled: Boolean(existing.dailyVerse?.enabled),
                }),
            });
            await interaction.followUp({
                content: `✅ Passive detection set to **${pickedLabel}**. Admins can change this anytime.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Welcome Select] Update/followUp failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
