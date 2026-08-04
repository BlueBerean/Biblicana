import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveDailyVerseConfig,
    readDailyVerseConfig,
    buildDailyVerseConfigView,
} from '../../utils/dailyVerseConfig.js';
import logger from '../../utils/logger.js';

export default {
    id: 'config:daily:hour',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:daily:hour') return;

        const raw = interaction.values?.[0];
        const hour = Number.parseInt(raw, 10);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
            return interaction.reply({ content: 'Invalid hour.', flags: MessageFlags.Ephemeral });
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

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + read below are Neon round-trips
        // that can outlast Discord's 3-second acknowledgement window.
        await interaction.deferUpdate();

        const saved = await saveDailyVerseConfig(database, interaction.guildId, { hour });
        if (!saved) {
            // Already acknowledged, so this must be a followUp, not a reply.
            return interaction.followUp({
                content: '⚠️ Could not save. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const current = await readDailyVerseConfig(database, interaction.guildId);
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildDailyVerseConfigView({ current }),
            });
            await interaction.followUp({
                content: `✅ Post time set to **${String(hour).padStart(2, '0')}:00 UTC**. Next post at that hour tomorrow (or today if the hour hasn't passed yet).`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[ConfigDaily Hour] Update failed for ${interaction.guildId}: ${err.message}`);
        }
    },
};
