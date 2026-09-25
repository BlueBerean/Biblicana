import { Status } from 'discord.js';
import * as Sentry from '@sentry/node';
import logger from './logger.js';

// Dead-man's switch, as a Sentry Cron Monitor. Sentry alerts when check-ins
// STOP, so the only thing that matters is checking in exactly when the bot is
// genuinely working — and staying silent otherwise.
//
// "Working" is not "running". On 2026-09-05 the droplet was page-cache-starved
// for hours while `pm2 list` said `online` the whole time; and a gateway
// session that has dropped leaves a live process that Discord delivers nothing
// to. A timer that checked in unconditionally would have reported both as
// healthy. So each tick asks Discord's own state first.
//
// On whenever Sentry is, in PRODUCTION only. A heartbeat treats silence as the
// alarm, so a dev bot checking in would page someone every time it was
// stopped for the night. No env var of its own: SENTRYDSN turns it on.
//
// Chosen over Healthchecks.io (the handoff's first suggestion) to keep one
// account and one dashboard. The trade is shared fate: during a Sentry outage
// there are no heartbeat alerts either. Sentry is off the droplet, so a dead
// droplet is still caught.

export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export const MONITOR_SLUG = 'biblicana-gateway';

// Sent with every check-in as an upsert, so the monitor is created on first
// use and its settings live here rather than in the Sentry UI.
//   checkinMargin 5 + failureIssueThreshold 2: one missed tick (a network
//   blip) is tolerated; two in a row open an issue, ~15-20 minutes after the
//   last good check-in.
export const MONITOR_CONFIG = Object.freeze({
    schedule: { type: 'interval', value: HEARTBEAT_INTERVAL_MS / 60000, unit: 'minute' },
    checkinMargin: 5,
    failureIssueThreshold: 2,
    recoveryThreshold: 1,
    timezone: 'UTC',
});

function sentryCheckIn() {
    Sentry.captureCheckIn({ monitorSlug: MONITOR_SLUG, status: 'ok' }, MONITOR_CONFIG);
}

/**
 * True only when the client has logged in AND every shard's socket is Ready.
 *
 * The shard check is the one that matters. isReady() reads the MANAGER's
 * status (`!ws.destroyed && ws.status === Ready`), and discord.js 14 sets that
 * once, in triggerClientReady(), and never sets it back: when a socket drops,
 * only `shard.status` moves (Connecting, Resuming, Disconnected — see
 * WebSocketManager's Closed/Hello/Resumed handlers). So `isReady() &&
 * ws.status === Ready` stays true through the exact failure this heartbeat
 * exists to catch. Verified against discord.js 14.26 source.
 */
export function isGatewayHealthy(client) {
    if (typeof client?.isReady !== 'function' || !client.isReady()) return false;
    const shards = client.ws?.shards;
    // No shards is not "all shards ready" — Array.every on nothing is true.
    if (!shards || shards.size === 0) return false;
    for (const shard of shards.values()) {
        if (shard.status !== Status.Ready) return false;
    }
    return true;
}

/** Shard statuses as "0:Ready" pairs, for the transition log line. */
function describeShards(client) {
    const shards = client?.ws?.shards;
    if (!shards || shards.size === 0) return 'no shards';
    // Status is a two-way enum: Status[0] === 'Ready'.
    return [...shards.values()].map(s => `${s.id}:${Status[s.status] ?? s.status}`).join(' ');
}

// Log a state CHANGE once, not every five minutes. A bot that is down for an
// hour should leave one line saying so, and one when it recovers.
let lastHealthy = null;

/** Reset the transition memory. Tests only. */
export function _resetHeartbeatState() {
    lastHealthy = null;
}

/**
 * One tick. Returns true when a check-in was sent. Never throws.
 * `checkIn` is injectable so tests need no Sentry client.
 */
export function sendHeartbeat(client, checkIn = sentryCheckIn) {
    const healthy = isGatewayHealthy(client);
    if (!healthy) {
        if (lastHealthy !== false) {
            logger.warn(`[Heartbeat] Gateway not ready (${describeShards(client)}); withholding check-ins until it is.`);
        }
        lastHealthy = false;
        return false;
    }
    if (lastHealthy === false) {
        logger.info('[Heartbeat] Gateway ready again; resuming check-ins.');
    }
    lastHealthy = true;

    try {
        // Queued on the SDK's transport, which sends in the background and
        // swallows its own network errors — nothing here can block or throw
        // into the bot. Delivery failures surface as a missed check-in, which
        // is the alert doing its job.
        checkIn();
        logger.debug('[Heartbeat] Check-in sent.');
        return true;
    } catch (err) {
        logger.warn(`[Heartbeat] Check-in failed: ${err.message}`);
        return false;
    }
}

/**
 * Whether this process should check in at all. Pure, for the tests.
 */
export function heartbeatEnabled({ sentryInitialized, environment }) {
    return Boolean(sentryInitialized) && environment === 'production';
}

/**
 * Start the heartbeat. Returns an interval handle for the shutdown path, or
 * null when it is off (no Sentry, or not production).
 *
 * Call it once on ClientReady: a bot that never reaches READY never checks
 * in, which is the alert working as intended.
 */
export function startHeartbeat(client, {
    sentryInitialized = Sentry.isInitialized(),
    environment = Sentry.getClient()?.getOptions()?.environment,
    checkIn = sentryCheckIn,
} = {}) {
    if (!heartbeatEnabled({ sentryInitialized, environment })) {
        logger.debug(sentryInitialized
            ? `[Heartbeat] Off in environment "${environment}" — check-ins are production-only.`
            : '[Heartbeat] Off — Sentry is not initialised.');
        return null;
    }

    const tick = () => {
        try {
            sendHeartbeat(client, checkIn);
        } catch (err) {
            logger.warn(`[Heartbeat] Tick failed: ${err.message}`);
        }
    };
    tick();
    const handle = setInterval(tick, HEARTBEAT_INTERVAL_MS);
    if (typeof handle.unref === 'function') handle.unref();

    logger.info(`[Heartbeat] Started — Sentry monitor "${MONITOR_SLUG}", every ${HEARTBEAT_INTERVAL_MS / 60000} minutes.`);
    return handle;
}
