import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveDailyVerseConfig,
    readDailyVerseConfig,
    buildDailyVerseConfigView,
    DAILY_ENABLED_OPTIONS,
} from '../../utils/dailyVerseConfig.js';
import logger from '../../utils/logger.js';

export default {
    id: 'config:daily:enabled',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:daily:enabled') return;

        const picked = interaction.values?.[0];
        if (picked !== 'on' && picked !== 'off') {
            return interaction.reply({ content: 'Unknown choice.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins can change daily-verse settings.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'Daily Verse is a per-server setting.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST. Everything above is synchronous — option parsing and
        // permission bits already resolved on the interaction — so this is the
        // last point before I/O. The save + read below are two Neon round-trips;
        // on a cold endpoint they exceed the 3-second window and the user sees
        // "This interaction failed". Reproduced live during the 2026-07-19 Neon
        // outage, where the retry succeeded once both layers were warm.
        await interaction.deferUpdate();

        const saved = await saveDailyVerseConfig(database, interaction.guildId, { enabled: picked === 'on' });
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        const pickedLabel = DAILY_ENABLED_OPTIONS.find(o => o.value === picked)?.label ?? picked;

        try {
            const current = await readDailyVerseConfig(database, interaction.guildId);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildDailyVerseConfigView({ current }),
            });
            await interaction.followUp({
                content: `✅ **${pickedLabel}**${picked === 'on' && (!current.channelId || current.hour === null) ? ' — don\'t forget to pick a channel and hour below.' : '.'}`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[ConfigDaily Enabled] Update failed for ${interaction.guildId}: ${err.message}`);
        }
    },
};
