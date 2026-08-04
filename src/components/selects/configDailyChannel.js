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

        // ACK FIRST — see configDailyEnabled.js for the full rationale. Every
        // check above is synchronous; the save + read below are Neon round-trips
        // that can outlast Discord's 3-second acknowledgement window.
        await interaction.deferUpdate();

        // Verify the bot can actually post here BEFORE saving. Previously this
        // select accepted any channel and only printed a "make sure Biblicana
        // has permission" reminder, so a bad pick failed silently every tick
        // forever after: 4 guilds in prod are currently in that state, three of
        // them retrying 12x/hour into a wall (see followups.md Ops section).
        //
        // Only refuse on CLEAR evidence. If the channel or member isn't
        // resolvable from cache we save anyway and warn — blocking on ambiguity
        // would break legitimate setups where the cache is simply incomplete.
        const targetChannel = interaction.guild?.channels?.cache?.get(channelId);
        const me = interaction.guild?.members?.me;
        const perms = targetChannel && me ? targetChannel.permissionsFor(me) : null;

        if (perms) {
            const missing = [];
            if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
            if (!perms.has(PermissionFlagsBits.SendMessages)) missing.push('Send Messages');

            if (missing.length) {
                logger.warn(`[ConfigDaily Channel] Rejected <#${channelId}> in guild ${interaction.guildId} — bot missing: ${missing.join(', ')}`);
                return interaction.followUp({
                    content: `❌ I can't post in <#${channelId}> — missing **${missing.join('** and **')}**.\n\nGrant those permissions there, then pick the channel again. (Nothing was saved, so daily verse won't silently fail.)`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        } else {
            logger.warn(`[ConfigDaily Channel] Could not resolve permissions for ${channelId} in guild ${interaction.guildId}; saving without a pre-check.`);
        }

        const saved = await saveDailyVerseConfig(database, interaction.guildId, { channelId });
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
                content: perms
                    ? `✅ Channel set to <#${channelId}> — permissions verified.`
                    : `✅ Channel set to <#${channelId}>. I couldn't verify my permissions there, so double-check I have View Channel + Send Messages.`,
                flags: MessageFlags.Ephemeral,
            });
        } catch (err) {
            logger.error(`[ConfigDaily Channel] Update failed for ${interaction.guildId}: ${err.message}`);
        }
    },
};
