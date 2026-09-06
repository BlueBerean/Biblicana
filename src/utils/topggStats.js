import logger from './logger.js';

// Post the guild count to top.gg so the listing shows it.
//
// Top.gg does NOT read the count from Discord — its docs say to post "whenever
// your bot's server count changes", and until something does, the listing shows
// no server count at all. That is why Biblicana sat in 500+ servers showing
// nothing while other bots appeared to report it automatically: they are all
// posting too, most via @top-gg/sdk's AutoPoster, which is this same request on
// a timer. Not worth a dependency for one endpoint in a tree deliberately
// slimmed to 11 direct deps.
//
//   POST https://top.gg/api/bots/<id>/stats
//   Authorization: <token>          (no "Bearer" prefix — top.gg is unusual here)
//   { "server_count": N }
//
// Token comes from top.gg/bot/<BOT_ID>/webhooks.
const TOPGG_ENDPOINT = 'https://top.gg/api/bots';

// Every 30 minutes. Top.gg allows 60 requests/minute, so the ceiling is
// nowhere near — the interval is chosen for how fast the number actually
// changes (a handful of joins a day), not for the limit. Posting per
// guildCreate/guildDelete would be chattier for no visible benefit, and a
// timer self-heals: a failed post is corrected 30 minutes later rather than
// leaving the listing stale until the next join.
const POST_INTERVAL_MS = 30 * 60 * 1000;

// Give up rather than hold a socket open. The listing being briefly stale is
// not worth a hung request on the bot's own event loop.
const REQUEST_TIMEOUT_MS = 10_000;

export async function postGuildCount(client) {
    const token = process.env.TOPGGTOKEN;
    const count = client.guilds?.cache?.size;

    // Nothing to say yet — the guild cache is populated on READY, and a 0 here
    // would publish a wrong number rather than no number.
    if (!Number.isInteger(count) || count === 0) {
        logger.debug('[TopGG] Skipping post — guild cache not populated yet.');
        return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${TOPGG_ENDPOINT}/${client.user.id}/stats`, {
            method: 'POST',
            headers: {
                Authorization: token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ server_count: count }),
            signal: controller.signal,
        });

        if (!res.ok) {
            // 401 means the token is wrong or was rotated; say so plainly,
            // because the symptom otherwise is just a listing that never
            // updates and nothing in the logs pointing at why.
            const hint = res.status === 401
                ? ' — check TOPGGTOKEN against top.gg/bot/<id>/webhooks'
                : '';
            logger.warn(`[TopGG] Stats post failed: HTTP ${res.status}${hint}`);
            return false;
        }

        logger.info(`[TopGG] Posted server_count=${count}`);
        return true;
    } catch (err) {
        // Never throw into the caller. A top.gg outage, a DNS failure or an
        // abort must not touch anything the bot does for its own users.
        const reason = err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : err.message;
        logger.warn(`[TopGG] Stats post failed: ${reason}`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Start posting the guild count to top.gg. Returns an interval handle for the
 * shutdown path, or null when nothing was started.
 *
 * Absent TOPGGTOKEN is a normal state, not an error: the test bot has no top.gg
 * listing at all. Logging it once at startup beats a warning every 30 minutes
 * for the rest of the process's life.
 */
export function startTopggPoster(client) {
    if (!process.env.TOPGGTOKEN) {
        logger.debug('[TopGG] No TOPGGTOKEN set — server count will not be posted.');
        return null;
    }

    postGuildCount(client).catch(err =>
        logger.warn(`[TopGG] Startup post failed: ${err.message}`)
    );

    const handle = setInterval(() => {
        postGuildCount(client).catch(err =>
            logger.warn(`[TopGG] Scheduled post failed: ${err.message}`)
        );
    }, POST_INTERVAL_MS);

    // Do not hold the process open for this alone.
    if (typeof handle.unref === 'function') handle.unref();

    logger.info(`[TopGG] Stats poster started — every ${POST_INTERVAL_MS / 60000} minutes.`);
    return handle;
}
