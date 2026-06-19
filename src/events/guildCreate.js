import { Events, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import logger from '../utils/logger.js';
import { buildWelcomeCard } from '../utils/welcomeCard.js';

// Known BibleBot application IDs. The primary is Kerygma Digital's BibleBot —
// by far the most-installed Discord Bible bot. If others become popular enough
// that admins want parity coexistence, add them here.
const KNOWN_BIBLEBOT_IDS = [
    '361033318273384449',  // BibleBot by Kerygma Digital
];

// Probe whether any known BibleBot variant is a member of this guild.
// Uses a REST fetch per ID (not the cache), so works even without the
// GuildMembers intent. Each fetch throws when the member doesn't exist;
// we swallow those and only treat unexpected errors as "unknown, assume no".
async function biblebotPresent(guild) {
    for (const id of KNOWN_BIBLEBOT_IDS) {
        try {
            const member = await guild.members.fetch(id);
            if (member) return true;
        } catch (err) {
            // 10007 = Unknown Member (expected: BibleBot isn't here). Any
            // other code is a real error we should surface at debug level.
            if (err?.code !== 10007) {
                logger.debug(`[GuildCreate] BibleBot probe for ${id} in ${guild.id} errored: ${err.message}`);
            }
        }
    }
    return false;
}

// Find the best channel to post the welcome card into. Prefers the guild's
// system channel; falls back to the first text/announcement channel the bot
// can send in. Returns null if no suitable channel exists (happens in locked-
// down servers where the inviter didn't grant Send Messages anywhere).
function findWelcomeChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;

    const canSend = (channel) =>
        channel
        && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
        && channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);

    if (canSend(guild.systemChannel)) return guild.systemChannel;

    // Fallback: iterate channels in position order so we pick "general" or the
    // top-most text channel rather than a random mid-list one.
    const ordered = [...guild.channels.cache.values()]
        .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const ch of ordered) {
        if (canSend(ch)) return ch;
    }
    return null;
}

export default {
    name: Events.GuildCreate,
    async execute(guild, database) {
        logger.info(`[GuildCreate] Joined guild ${guild.name} (${guild.id}) with ${guild.memberCount} members`);

        // Smart default: if BibleBot is already here, coexist politely
        // (react to its posts rather than duplicating verses). Otherwise,
        // assume the admin would prefer full utility (autopost).
        const hasBibleBot = await biblebotPresent(guild);
        const defaultMode = hasBibleBot ? 'react_biblebot' : 'autopost';
        logger.info(`[GuildCreate] BibleBot present=${hasBibleBot} — default passive mode: ${defaultMode}`);

        // Seed the guild record so downstream detection can read without a
        // null check. Safe if the row already exists (setGuildValue is upsert).
        try {
            await database.setGuildValue(guild.id, { id: guild.id, passiveMode: defaultMode });
        } catch (err) {
            logger.error(`[GuildCreate] Failed to seed guild record for ${guild.id}: ${err.message}`);
        }

        const channel = findWelcomeChannel(guild);
        if (!channel) {
            logger.warn(`[GuildCreate] No postable channel in guild ${guild.id} — welcome card skipped`);
            return;
        }

        try {
            await channel.send({
                flags: MessageFlags.IsComponentsV2,
                components: buildWelcomeCard({
                    currentPassiveMode: defaultMode,
                    currentAiEnabled: false,
                    currentDailyEnabled: false,
                }),
            });
            logger.info(`[GuildCreate] Welcome card posted in #${channel.name} (${channel.id}) of ${guild.id}`);
        } catch (err) {
            logger.error(`[GuildCreate] Failed to send welcome card in ${guild.id}: ${err.message}`);
        }
    },
};
