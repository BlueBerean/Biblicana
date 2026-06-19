import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveDailyVerseConfig,
    readDailyVerseConfig,
    buildDailyVerseConfigView,
} from '../../utils/dailyVerseConfig.js';
import logger from '../../utils/logger.js';

// Handles the ChannelSelectMenu for daily-verse channel picking.
// interaction.values contains one channel ID (we set maxValues=1).
export default {
    id: 'config:daily:channel',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:daily:channel') return;

        const channelId = interaction.values?.[0];
        if (!channelId) {
            return interaction.reply({ content: 'No channel selected.', flags: MessageFlags.Ephemeral });
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

        const saved = await saveDailyVerseConfig(database, interaction.guildId, { channelId });
        if (!saved) {
            return interaction.reply({
                content: '⚠️ Could not save. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            const current = await readDailyVerseConfig(database, interaction.guildId);
            await interaction.update({
                flags: MessageFlags.IsComponentsV2,
                components: buildDailyVerseConfigView({ current }),
            });
            await interaction.followUp({
                content: `✅ Channel set to <#${channelId}>. Make sure Biblicana has View Channel + Send Messages permission there.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[ConfigDaily Channel] Update failed for ${interaction.guildId}: ${err.message}`);
        }
    },
};
