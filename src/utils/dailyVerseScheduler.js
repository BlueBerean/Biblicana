import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { renderVerseOfTheDay } from './dailyVerseRenderer.js';
import { saveDailyVerseConfig } from './dailyVerseConfig.js';
import logger from './logger.js';

// Tick every 5 minutes. The scheduler checks the current UTC hour against
// each guild's configured hour; any guild whose hour matches and hasn't
// posted yet today gets the verse. 5 minutes means posts land within
// ~0-5 minutes of the configured hour boundary — tight enough to feel
// "on the hour" to users, loose enough not to hammer Redis every minute.
const SCHEDULER_TICK_MS = 5 * 60 * 1000;

// Today's date in UTC as YYYY-MM-DD. Used as the lastPostedDate marker.
function todayUTCDateString() {
    return new Date().toISOString().slice(0, 10);
}

async function postDailyVerseToGuild(guild, dailyVerse, database) {
    const channel = guild.channels.cache.get(dailyVerse.channelId);
    if (!channel) {
        logger.warn(`[DailyVerse] Channel ${dailyVerse.channelId} missing in guild ${guild.id}; disabling auto-post.`);
        await saveDailyVerseConfig(database, guild.id, { enabled: false });
        return false;
    }

    const me = guild.members.me;
    if (!me) {
        logger.warn(`[DailyVerse] No guild.members.me for ${guild.id}; skipping.`);
        return false;
    }
    const perms = channel.permissionsFor(me);
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
        logger.warn(`[DailyVerse] Missing Send/View permission in #${channel.name} (${channel.id}) for guild ${guild.id}.`);
        return false;
    }

    const components = await renderVerseOfTheDay({ translation: 'BSB' });
    if (!components) {
        logger.warn(`[DailyVerse] Render failed for guild ${guild.id}; skipping post.`);
        return false;
    }

    try {
        await channel.send({
            flags: MessageFlags.IsComponentsV2,
            components,
        });
        logger.info(`[DailyVerse] Posted to guild=${guild.id} channel=${channel.id}`);
        return true;
    } catch (err) {
        logger.error(`[DailyVerse] Send failed in ${guild.id}/${channel.id}: ${err.message}`);
        return false;
    }
}

export async function runDailyVerseTick(client, database) {
    const now = new Date();
    const currentHourUTC = now.getUTCHours();
    const today = todayUTCDateString();

    let candidates = 0;
    let posted = 0;

    for (const guild of client.guilds.cache.values()) {
        try {
            const g = await database.getGuildValue(guild.id);
            const dv = g?.dailyVerse;
            if (!dv?.enabled) continue;
            if (!dv.channelId || typeof dv.hour !== 'number') continue;
            if (dv.hour !== currentHourUTC) continue;
            if (dv.lastPostedDate === today) continue;

            candidates++;
            const success = await postDailyVerseToGuild(guild, dv, database);
            if (success) {
                // Mark posted regardless — if we got here we tried.
                // Prevents retry-storm if e.g. rate-limit hits on first post.
                await saveDailyVerseConfig(database, guild.id, { lastPostedDate: today });
                posted++;
            }
        } catch (err) {
            logger.error(`[DailyVerse] Tick error for guild ${guild.id}: ${err.message}`);
        }
    }

    if (candidates > 0) {
        logger.info(`[DailyVerse] Tick complete: hour=${currentHourUTC}UTC candidates=${candidates} posted=${posted}`);
    }
}

/**
 * Start the daily verse scheduler. Kicks off the first tick immediately
 * (catches up on any post due at bot startup time) and then runs every
 * 5 minutes. Returns the interval handle so the caller can clear it on
 * shutdown if needed.
 */
export function startDailyVerseScheduler(client, database) {
    // One immediate tick at startup — if the bot was offline during its
    // configured hour, this catches the post as soon as we're up (before
    // lastPostedDate advances at UTC midnight).
    runDailyVerseTick(client, database).catch(err =>
        logger.error(`[DailyVerse] Startup tick failed: ${err.message}`)
    );

    const handle = setInterval(() => {
        runDailyVerseTick(client, database).catch(err =>
            logger.error(`[DailyVerse] Scheduled tick failed: ${err.message}`)
        );
    }, SCHEDULER_TICK_MS);

    logger.info(`[DailyVerse] Scheduler started — ticks every ${SCHEDULER_TICK_MS / 1000}s`);
    return handle;
}
