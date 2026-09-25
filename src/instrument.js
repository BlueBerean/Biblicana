// Sentry, loaded BEFORE the bot:  node --import ./src/instrument.js src/index.js
//
// Why a separate file: tracing works by hooking pg, ioredis and the HTTP client
// as they load. Under ESM every static import in index.js is resolved before a
// line of it runs, so a Sentry.init() at the top of index.js is already too
// late to hook anything. --import runs this module first. (Needs Node 18.19+;
// the bot moved to 22 for this.)
//
// Started WITHOUT --import, the bot runs normally with Sentry off, and index.js
// warns if SENTRYDSN is set — so a PM2 config that forgot the flag is visible
// rather than a silently empty Sentry project.

// This file runs before index.js, so it must load .env itself.
import 'dotenv/config';
import fs from 'node:fs';
import * as Sentry from '@sentry/node';
import logger from './utils/logger.js';
import { buildSentryOptions } from './utils/sentryConfig.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const options = buildSentryOptions(process.env, version, msg => logger.warn(msg));

if (options) {
    // Imported only when enabled: the profiler is a native module, and a dev
    // machine or test bot without a DSN has no reason to load it.
    const { nodeProfilingIntegration } = await import('@sentry/profiling-node');

    Sentry.init({
        ...options,
        integrations: [
            nodeProfilingIntegration(),
            // Pinned explicitly rather than trusting the SDK default: 'warn'
            // reports an unhandled rejection and keeps the process up, which is
            // what index.js's own handler has always done. A future default of
            // 'strict' would exit on every one — a restart across ~570 servers.
            Sentry.onUnhandledRejectionIntegration({ mode: 'warn' }),
        ],
    });

    logger.info(
        `[Sentry] Enabled — environment=${options.environment} release=${options.release} ` +
        `traces=${options.tracesSampleRate} profiling=${options.profileSessionSampleRate}`
    );
} else {
    logger.debug('[Sentry] No SENTRYDSN set — error reporting is off.');
}
