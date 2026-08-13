import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    savePassiveChannels,
    readPassiveMode,
    readPassivePaginate,
    readPassivePagerPrivate,
    buildConfigView,
} from '../../utils/passiveConfig.js';
import logger from '../../utils/logger.js';

// Handles the ChannelSelectMenu that limits WHERE passive scripture detection
// scans. customId "config:passive:channels". interaction.values is the
// (possibly empty) list of allowed channel IDs — empty clears the restriction
// and returns to scanning every channel the bot can read.
//
// Sibling of configAiChannels.js, and deliberately identical in shape: same
// allowlist semantics, same ack-first ordering, same "empty means everywhere"
// default. The two gates are independent — restricting passive detection says
// nothing about where the AI conversation may run, and vice versa.
export default {
    id: 'config:passive:channels',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:passive:channels') return;

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins (with Manage Server permission) can change passive detection channels.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'Passive detection is a per-server setting — this has no effect in DMs.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const channelIds = interaction.values ?? [];

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + read below are Neon
        // round-trips that can outlast Discord's 3-second ack window.
        await interaction.deferUpdate();

        const saved = await savePassiveChannels(database, interaction.guildId, channelIds);
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save that right now. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            // Re-read the mode so the re-rendered panel doesn't show it as
            // reset. The panel is rebuilt whole on every change, so a setting
            // this handler doesn't source renders as unset even though the
            // database still holds it.
            const [currentPassiveMode, currentPaginate, currentPagerPrivate] = await Promise.all([
                readPassiveMode(database, interaction.guildId),
                readPassivePaginate(database, interaction.guildId),
                readPassivePagerPrivate(database, interaction.guildId),
            ]);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildConfigView({ currentPassiveMode, currentChannels: channelIds, currentPaginate, currentPagerPrivate }),
            });

            // Name the mode interaction explicitly: an admin who picks channels
            // while the mode is still 'silent' has changed nothing observable,
            // and would reasonably read the confirmation as "it's on now".
            const stillSilent = currentPassiveMode === 'silent'
                ? '\n\n-# Passive detection is currently set to **silent**, so nothing is scanned anywhere yet — pick a mode above to turn it on.'
                : '';
            const confirmation = channelIds.length === 0
                ? `✅ Cleared — Biblicana watches for scripture references in **all channels** it can read again.${stillSilent}`
                : `✅ Passive detection now runs only in: ${channelIds.map(id => `<#${id}>`).join(' ')}. Other channels are ignored entirely. Slash commands still work everywhere.${stillSilent}`;
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Config Passive Channels] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
