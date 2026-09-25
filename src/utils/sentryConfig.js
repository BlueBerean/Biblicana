import { scrubBreadcrumb, scrubEvent, scrubSpan } from './sentryScrub.js';

// Sentry settings, as a pure function of the environment so the tests can pin
// them without starting the SDK. src/instrument.js is the only caller.
//
// Env vars (all optional, UPPERCASE no underscores like the rest of .env):
//   SENTRYDSN          absent -> Sentry stays off entirely, like TOPGGTOKEN
//   SENTRYENVIRONMENT  defaults from NODE_ENV: "production" or "development"
//   SENTRYTRACESRATE   0..1, share of commands / AI chats traced (default 1)
//   SENTRYPROFILERATE  0..1, chance THIS PROCESS profiles its traces (default 1)

// Everything. Measured on prod 2026-09-24 over seven days of logs: 5-22 slash
// commands and 7-40 button clicks a day across ~570 servers. At ~10 spans an
// interaction that is ~1,000 spans a day, ~30k a month, against 5M included.
// A first guess of 0.1 ("570 servers would exhaust the quota") was wrong by
// two orders of magnitude and would have left prod with one or two traces a
// day — too few to diagnose anything. Lower it with SENTRYTRACESRATE if usage
// ever grows a hundredfold.
export const DEFAULT_TRACES_RATE = 1;

// Profiling runs only inside a sampled trace (profileLifecycle 'trace'), so
// the traces rate already bounds its cost. profileSessionSampleRate is rolled
// ONCE per process start, which makes it an on/off switch, not a share.
export const DEFAULT_PROFILE_RATE = 1;

/**
 * Parse a 0..1 rate. An unparseable value falls back to the default AND says
 * so — a typo in .env silently tracing nothing is exactly the kind of failure
 * that looks like a quiet week.
 */
export function parseRate(raw, fallback, name, warn = () => {}) {
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
        warn(`[Sentry] ${name}="${raw}" is not a number between 0 and 1; using ${fallback}.`);
        return fallback;
    }
    return n;
}

/**
 * Returns the options for Sentry.init, or null when Sentry should stay off.
 * Integrations are added by the caller, which owns the SDK imports.
 */
export function buildSentryOptions(env, version, warn = () => {}) {
    const dsn = env.SENTRYDSN?.trim();
    if (!dsn) {
        // SENTRY_DSN is Sentry's own documented name, so it is the natural
        // thing to type — and it happened on the very first setup. Unread, it
        // leaves Sentry off with nothing but a debug line, which looks exactly
        // like a bot with no errors.
        if (env.SENTRY_DSN?.trim()) {
            warn('[Sentry] SENTRY_DSN is set but this bot reads SENTRYDSN (no underscore, like every var in .env). Sentry is OFF until it is renamed.');
        }
        return null;
    }

    return {
        dsn,
        environment: env.SENTRYENVIRONMENT?.trim()
            || (env.NODE_ENV === 'production' ? 'production' : 'development'),
        // Matches pm2 list and the embed footer, so an issue's "first seen in"
        // reads as a version someone can find.
        release: `biblicana@${version}`,

        // No IPs, no request bodies. The hooks below cover what this flag
        // cannot know about: Discord message text and usernames.
        sendDefaultPii: false,
        beforeSend: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
        // Not beforeSendTransaction: Sentry 11 streams spans by default and
        // ignores that hook entirely (it warns at startup if set).
        beforeSendSpan: scrubSpan,

        tracesSampleRate: parseRate(env.SENTRYTRACESRATE, DEFAULT_TRACES_RATE, 'SENTRYTRACESRATE', warn),
        profileSessionSampleRate: parseRate(env.SENTRYPROFILERATE, DEFAULT_PROFILE_RATE, 'SENTRYPROFILERATE', warn),
        profileLifecycle: 'trace',
    };
}
