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

// In-memory record of guilds already posted-to this process, keyed
// `${guildId}:${YYYY-MM-DD}`. The durable dedupe marker is `lastPostedDate` in
// the guild record, but if that write fails (a routine Postgres blip), the next
// 5-min tick re-reads no marker and re-posts — up to 12 times in the matching
// hour, across every affected guild. This process-lifetime guard makes a
// successful post idempotent even when the durable write fails. Bounded to one
// day's entries (cleared on date rollover); a restart re-reads lastPostedDate.
const postedThisProcess = new Set();
let memoDate = null;

// Overlap guard: a slow tick (DB latency / Discord rate-limiting across many
// guilds) could still be running when the next 5-min interval fires, doubling
// concurrent work and racing the dedupe. Skip if one is already in flight.
let tickInFlight = false;

export async function runDailyVerseTick(client, database) {
    if (tickInFlight) {
        logger.warn('[DailyVerse] Previous tick still in flight; skipping this tick.');
        return;
    }
    tickInFlight = true;
    try {
        const now = new Date();
        const currentHourUTC = now.getUTCHours();
        const today = todayUTCDateString();

        // Keep the in-memory guard bounded to the current day.
        if (memoDate !== today) {
            postedThisProcess.clear();
            memoDate = today;
        }

        let candidates = 0;
        let posted = 0;
        let orphaned = 0;

        // ONE query for every guild with daily verse enabled, rather than one
        // query per guild in the client cache. The old shape issued ~527
        // queries every 5 minutes (~144,000/day) to find ~14 guilds, and was
        // the largest single consumer of the Neon compute quota.
        //
        // A failure here aborts the whole tick rather than degrading to a
        // partial run: without the enabled list there is nothing to iterate,
        // and silently posting to zero guilds would look identical to "no
        // guilds are due right now."
        let enabledGuilds;
        try {
            enabledGuilds = await database.getDailyVerseGuilds();
        } catch (err) {
            logger.error(`[DailyVerse] Could not load enabled guilds; skipping tick: ${err.message}`);
            return;
        }

        for (const { guildId, dailyVerse: dv } of enabledGuilds) {
            try {
                if (!dv) continue;
                if (!dv.channelId || typeof dv.hour !== 'number') continue;
                if (dv.hour !== currentHourUTC) continue;
                if (dv.lastPostedDate === today) continue;

                const memoKey = `${guildId}:${today}`;
                if (postedThisProcess.has(memoKey)) continue;   // posted this process; durable write may have failed

                // A guilddata row outlives the bot's membership — a server that
                // removed the bot keeps its row until pruned. Previously this
                // case was impossible (we iterated the live cache); now the DB
                // is the source of truth, so orphaned rows must be skipped
                // explicitly rather than throwing on a missing guild.
                const guild = client.guilds.cache.get(guildId);
                if (!guild) {
                    orphaned++;
                    continue;
                }

                candidates++;
                const success = await postDailyVerseToGuild(guild, dv, database);
                if (success) {
                    // Mark in-memory FIRST so a failed durable write can't cause a
                    // re-post on the next tick within this process lifetime.
                    postedThisProcess.add(memoKey);
                    const persisted = await saveDailyVerseConfig(database, guildId, { lastPostedDate: today });
                    if (persisted === false) {
                        logger.error(`[DailyVerse] Posted to ${guildId} but FAILED to persist lastPostedDate — in-memory guard prevents re-post until restart.`);
                    }
                    posted++;
                }
            } catch (err) {
                logger.error(`[DailyVerse] Tick error for guild ${guildId}: ${err.message}`);
            }
        }

        const elapsedMs = Date.now() - now.getTime();

        if (orphaned > 0) {
            logger.warn(`[DailyVerse] ${orphaned} enabled guild(s) have rows but the bot is no longer a member — candidates for pruning.`);
        }

        // Always emit a tick line at debug so the query-count reduction is
        // verifiable in the logs; promote to info only when work happened, to
        // keep the 288 ticks/day from flooding prod at info level.
        const summary = `hour=${currentHourUTC}UTC enabled=${enabledGuilds.length} candidates=${candidates} posted=${posted} orphaned=${orphaned} elapsed=${elapsedMs}ms queries=1`;
        if (candidates > 0) {
            logger.info(`[DailyVerse] Tick complete: ${summary}`);
        } else {
            logger.debug(`[DailyVerse] Tick complete: ${summary}`);
        }
    } finally {
        tickInFlight = false;
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
