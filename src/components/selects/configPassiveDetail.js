import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    savePassiveDetail,
    readPassiveMode,
    readPassiveChannels,
    readPassivePaginate,
    readPassivePagerPrivate,
    buildConfigView,
    PASSIVE_DETAIL_OPTIONS,
} from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Select-menu handler for how much of a passage an auto-post card shows.
// customId "config:passive:detail".
//
// Like every handler on this panel, it re-renders the WHOLE view and so must
// read every setting it did not itself change. Miss one and the database keeps
// the right value while the panel renders it as unset, which reads to an admin
// as their setting having just been wiped. tests/configPanels.test.js asserts
// this structurally.
export default {
    id: 'config:passive:detail',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:passive:detail') return;

        const picked = interaction.values?.[0];
        if (picked !== 'full' && picked !== 'compact') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change how much of a passage shows.',
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
        // check above is synchronous; the save + reads below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await savePassiveDetail(database, interaction.guildId, picked);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = PASSIVE_DETAIL_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const [currentPassiveMode, currentChannels, currentPaginate, currentPagerPrivate] = await Promise.all([
                readPassiveMode(database, interaction.guildId),
                readPassiveChannels(database, interaction.guildId),
                readPassivePaginate(database, interaction.guildId),
                readPassivePagerPrivate(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildConfigView({
                    currentPassiveMode,
                    currentChannels,
                    currentPaginate,
                    currentPagerPrivate,
                    currentDetail: picked,
                }),
            });

            // Same courtesy the layout picker pays: say up front when a setting
            // cannot show its effect yet, rather than letting an admin change it
            // in react mode and conclude it is broken.
            const notAutopost = currentPassiveMode !== 'autopost'
                ? `\n\n-# Only applies to the **auto-post** mode. This server is set to **${currentPassiveMode}**, so nothing will look different until you switch.`
                : '';
            const confirmation = picked === 'full'
                ? `✅ Verse detail set to **${pickedLabel}** — passages now use as much of the card as they can. Anything still too long gets a **Read full** button that opens the whole passage privately.${notAutopost}`
                : `✅ Verse detail set to **${pickedLabel}** — shorter excerpts, so long quotes don't push conversation off screen. A **Read full** button still opens the whole passage privately.${notAutopost}`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config Passive Detail] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
