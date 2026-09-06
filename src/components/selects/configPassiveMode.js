import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import { PASSIVE_MODES } from '../../database/schemas/guild.js';
import { PASSIVE_MODE_OPTIONS } from '../../utils/welcomeCard.js';
import { savePassiveMode, readPassiveChannels, readPassivePaginate, readPassivePagerPrivate, readPassiveDetail, buildConfigView } from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for the compact /config passive panel. customId:
// "config:passive". Same save path as the welcome card, different render
// target — updates the ephemeral /config message rather than the public
// welcome card.
export default {
    id: 'config:passive',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:passive') return;

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
        // check above is synchronous; savePassiveMode below is a Neon round-trip
        // that can outlast Discord's 3-second acknowledgement window.
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
            // Re-read the channel allowlist. The panel is rebuilt whole here,
            // so a setting this handler doesn't source renders as unset even
            // though the database still holds it — which reads to an admin as
            // their channel restriction having just been cleared.
            const [currentChannels, currentPaginate, currentPagerPrivate, currentDetail] = await Promise.all([
                readPassiveChannels(database, interaction.guildId),
                readPassivePaginate(database, interaction.guildId),
                readPassivePagerPrivate(database, interaction.guildId),
                readPassiveDetail(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildConfigView({ currentPassiveMode: picked, currentChannels, currentPaginate, currentPagerPrivate, currentDetail }),
            });
            await interaction.followUp({
                content: `✅ Passive detection set to **${pickedLabel}**.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[Config Select] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
