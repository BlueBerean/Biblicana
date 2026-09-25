import * as Sentry from '@sentry/node';

// One place that turns a caught error into a Sentry event, so each catch site
// is a single line and the tags stay consistent enough to filter on.
//
// Safe to call whether or not Sentry is running: without the instrument.js
// preload the SDK is uninitialised and captureException is a no-op.
//
// Tags, not context, because tags are what Sentry's issue search and
// dashboards filter by:
//   area     command | button | select | message | aichat | aichat-tool
//   handler  the command name, component prefix, or tool name
//   guild    the guild ID — lets an error be traced to the server reporting it
//   code     Discord API error code, when there is one

// Discord's "Unknown interaction": the 3-second acknowledgement window passed.
// See docs/10062-diagnostic.md. These are a latency signal, not a bug in the
// handler that threw them, so they are filed as warnings and grouped per
// handler — one issue per slow command, rather than one per stack shape.
export const DISCORD_UNKNOWN_INTERACTION = 10062;

export function reportError(error, { area, handler, guildId, level } = {}) {
    try {
        Sentry.withScope(scope => {
            if (area) scope.setTag('area', area);
            if (handler) scope.setTag('handler', handler);
            if (guildId) scope.setTag('guild', String(guildId));

            const code = error?.code;
            if (code !== undefined && code !== null) scope.setTag('code', String(code));

            if (code === DISCORD_UNKNOWN_INTERACTION) {
                scope.setLevel('warning');
                scope.setFingerprint(['discord-10062', handler ?? 'unknown']);
            } else if (level) {
                scope.setLevel(level);
            }

            Sentry.captureException(error);
        });
    } catch {
        // Reporting must never become a second failure inside a catch block.
    }
}

/**
 * The first segment of a parametric customId ("strongs:Greek:G2316" ->
 * "strongs"). The full ID carries per-click arguments, which would split one
 * button's errors into as many issues as there are verses.
 */
export function componentName(customId) {
    if (typeof customId !== 'string' || customId === '') return 'unknown';
    return customId.split(':')[0];
}
