// Behavioural coverage for error reporting: the REAL Sentry SDK, initialised in
// this process with a transport that records envelopes and sends nothing, so
// every assertion is about what Sentry would actually have received.
//
// Why it matters: until 2026-09-25 most commands caught their own errors,
// apologised to the user and reported nothing. The first live proof was a
// /stats that failed with 10062 in prod and never reached Sentry.
//
// node --test runs each test file in its own process, so initialising Sentry
// here cannot leak into any other test file. The DSN is fake on purpose: a
// command module below imports dotenv/config, which loads the developer's
// real SENTRYDSN into process.env; this file never reads it.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Sentry from '@sentry/node';
import log from 'loglevel';

import { reportError, withReportingScope } from '../src/utils/errorReporting.js';
import stats from '../src/commands/stats.js';

log.setLevel('silent');

const sent = [];

before(() => {
    Sentry.init({
        dsn: 'https://publickey@o0.ingest.us.sentry.io/1',
        defaultIntegrations: false,   // no console/http hooks: only what we capture
        transport: () => ({
            send: async (envelope) => { sent.push(envelope); return {}; },
            flush: async () => true,
        }),
    });
});

beforeEach(() => { sent.length = 0; });

// Error events captured since the last reset, as plain objects.
async function captured() {
    await Sentry.flush(2000);
    const events = [];
    for (const [, items] of sent) {
        for (const [header, item] of items) {
            if (header.type === 'event') events.push(item);
        }
    }
    return events;
}

const discordError = (code, message) => Object.assign(new Error(message), { code });

// A minimal interaction that /stats accepts. `replies` controls what each
// successive interaction.reply() does: 'ok' resolves, an Error rejects.
function fakeInteraction(replies) {
    const queue = [...replies];
    const calls = [];
    return {
        calls,
        guildId: '456209352773206016',
        client: {
            ws: { ping: 42, shards: new Map([[0, {}]]) },
            uptime: 3_600_000,
            guilds: { cache: { size: 592 } },
            users: { cache: { size: 10 } },
            user: { username: 'Biblicana' },
        },
        async reply(payload) {
            calls.push(payload);
            const next = queue.shift() ?? 'ok';
            if (next instanceof Error) throw next;
            return {};
        },
    };
}

// --- reportError --------------------------------------------------------------

test('reportError sends one event with its tags', async () => {
    reportError(new Error('boom'), { area: 'command', handler: 'bible', guildId: '123' });
    const events = await captured();
    assert.equal(events.length, 1);
    assert.equal(events[0].exception.values[0].value, 'boom');
    assert.equal(events[0].tags.area, 'command');
    assert.equal(events[0].tags.handler, 'bible');
    assert.equal(events[0].tags.guild, '123');
});

test('a 10062 is a warning grouped per handler', async () => {
    reportError(discordError(10062, 'Unknown interaction'), { area: 'command', handler: 'stats' });
    const [ev] = await captured();
    assert.equal(ev.level, 'warning');
    assert.deepEqual(ev.fingerprint, ['discord-10062', 'stats']);
    assert.equal(ev.tags.code, '10062');
});

test('a 10062 groups by the INHERITED handler when none is passed', async () => {
    // A catch site deep in a command may rely on the interaction scope.
    await withReportingScope({ area: 'button', handler: 'openverse' }, async () => {
        reportError(discordError(10062, 'Unknown interaction'));
    });
    const [ev] = await captured();
    assert.deepEqual(ev.fingerprint, ['discord-10062', 'openverse']);
});

// --- withReportingScope -------------------------------------------------------

test('scope tags survive awaits and reach reportError without being passed', async () => {
    await withReportingScope({ area: 'command', handler: 'fathers', guildId: '777' }, async () => {
        await new Promise(r => setTimeout(r, 10));
        reportError(new Error('deep inside'));
    });
    const [ev] = await captured();
    assert.equal(ev.tags.area, 'command');
    assert.equal(ev.tags.handler, 'fathers');
    assert.equal(ev.tags.guild, '777');
});

test('concurrent interactions keep their own tags', async () => {
    // A finishes after B; neither may see the other's guild.
    await Promise.all([
        withReportingScope({ guildId: 'A' }, async () => {
            await new Promise(r => setTimeout(r, 20));
            reportError(new Error('from A'));
        }),
        withReportingScope({ guildId: 'B' }, async () => {
            await new Promise(r => setTimeout(r, 5));
            reportError(new Error('from B'));
        }),
    ]);
    const events = await captured();
    const byMsg = Object.fromEntries(events.map(e => [e.exception.values[0].value, e.tags.guild]));
    assert.deepEqual(byMsg, { 'from A': 'A', 'from B': 'B' });
});

test('scope tags do not leak outside the scope', async () => {
    await withReportingScope({ guildId: 'inside' }, async () => {});
    reportError(new Error('after'));
    const [ev] = await captured();
    assert.equal(ev.tags?.guild, undefined);
});

test('withReportingScope returns the result and propagates errors', async () => {
    assert.equal(await withReportingScope({}, async () => 7), 7);
    await assert.rejects(withReportingScope({}, async () => { throw new Error('x'); }), /x/);
});

// --- a real command, end to end ----------------------------------------------

test('a failing /stats reply is reported, tagged with the command and guild', async () => {
    // The 2026-09-25 case: the reply fails, the command catches it and
    // apologises. Before this change nothing reached Sentry.
    const interaction = fakeInteraction([discordError(10062, 'Unknown interaction'), 'ok']);
    await withReportingScope(
        { area: 'command', handler: 'stats', guildId: interaction.guildId },
        () => stats.execute(interaction)
    );
    const events = await captured();
    assert.equal(events.length, 1, 'exactly one event');
    assert.equal(events[0].tags.handler, 'stats');
    assert.equal(events[0].tags.area, 'command');
    assert.equal(events[0].tags.guild, '456209352773206016', 'guild comes from the interaction scope');
    assert.equal(events[0].level, 'warning', '10062 is filed as a warning');
    assert.equal(interaction.calls.length, 2, 'the apology was still attempted');
});

test('when the apology also fails, the failure is still reported only once', async () => {
    // The nested reply-failure catch is a consequence of the first error and
    // must not file a second event.
    const interaction = fakeInteraction([new Error('render failed'), new Error('apology failed')]);
    await withReportingScope({ area: 'command', handler: 'stats' }, () => stats.execute(interaction));
    const events = await captured();
    assert.equal(events.length, 1);
    assert.equal(events[0].exception.values[0].value, 'render failed', 'the ROOT error, not the apology');
});

test('a successful /stats reports nothing', async () => {
    const interaction = fakeInteraction(['ok']);
    await withReportingScope({ area: 'command', handler: 'stats' }, () => stats.execute(interaction));
    assert.equal((await captured()).length, 0);
});
