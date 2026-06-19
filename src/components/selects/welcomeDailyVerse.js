import { PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import { buildWelcomeCard } from '../../utils/welcomeCard.js';
import {
    saveDailyVerseConfig,
    readDailyVerseConfig,
} from '../../utils/dailyVerseConfig.js';
import { readAiEnabled } from '../../utils/aiConfig.js';
import logger from '../../utils/logger.js';

const DEFAULT_HOUR_UTC = 13;  // 8am CDT / 9am EDT / 6am PDT — morning in US

// When enabling from the welcome card, we need a channel to post to. Prefer
// the guild's system channel; fall back to the first text channel the bot
// can send in; return null if nothing works.
function pickDefaultChannelId(guild) {
    const me = guild.members.me;
    if (!me) return null;
    const canSend = (ch) =>
        ch
        && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
        && ch.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
    if (canSend(guild.systemChannel)) return guild.systemChannel.id;
    const ordered = [...guild.channels.cache.values()]
        .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const ch of ordered) if (canSend(ch)) return ch.id;
    return null;
}

export default {
    id: 'welcome:daily',
    async execute(interaction, database) {
        if (interaction.customId !== 'welcome:daily') return;

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

        const current = await readDailyVerseConfig(database, interaction.guildId);

        let patch;
        let confirmation;
        if (picked === 'on') {
            // Only pick a default channel if the admin hasn't already set one.
            // Respects prior /config daily customization.
            const channelId = current.channelId || pickDefaultChannelId(interaction.guild);
            const hour = typeof current.hour === 'number' ? current.hour : DEFAULT_HOUR_UTC;
            if (!channelId) {
                return interaction.reply({
                    content: '⚠️ No postable text channel found in this server. Grant me access to a channel, then try again.',
                    flags: MessageFlags.Ephemeral,
                });
            }
            patch = { enabled: true, channelId, hour };
            const tzHint = hour === DEFAULT_HOUR_UTC ? ' (8am CDT / 9am EDT)' : '';
            confirmation = `✅ Daily Verse **enabled** — posting to <#${channelId}> at ${String(hour).padStart(2, '0')}:00 UTC${tzHint}. Tune with \`/config daily\`.`;
        } else {
            patch = { enabled: false };
            confirmation = `✅ Daily Verse **disabled**. Channel and hour settings retained for next time.`;
        }

        const saved = await saveDailyVerseConfig(database, interaction.guildId, patch);
        if (!saved) {
            return interaction.reply({
                content: '⚠️ Could not save. Try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
        }

        try {
            // Re-read so the re-render reflects the full persisted state
            // (including channelId / hour if they were just set).
            const existing = await database.getGuildValue(interaction.guildId) ?? {};
            const refreshedDaily = existing.dailyVerse ?? {};
            await interaction.update({
                flags: MessageFlags.IsComponentsV2,
                components: buildWelcomeCard({
                    currentPassiveMode: existing.passiveMode ?? 'react_biblebot',
                    currentAiEnabled: Boolean(existing.aiEnabled),
                    currentDailyEnabled: Boolean(refreshedDaily.enabled),
                }),
            });
            await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
        } catch (err) {
            logger.error(`[Welcome Daily Select] Update failed for guild ${interaction.guildId}: ${err.message}`);
        }
    },
};
