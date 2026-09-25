// Coverage for what the bot sends to Sentry, and when.
//
// Two promises are pinned here. First, Sentry is OFF unless SENTRYDSN is set,
// like TOPGGTOKEN: the dev bot and every test run must not report. Second, no
// user-written text or username leaves the bot. AI chat carries whatever
// people type at it across ~570 servers, and sendDefaultPii:false does not
// know what a Discord message is.
//
// The largest leak is breadcrumbs: Sentry's Console integration ships the bot's
// recent log lines with every error, and loglevel writes through console.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    buildSentryOptions,
    parseRate,
    DEFAULT_TRACES_RATE,
    DEFAULT_PROFILE_RATE,
} from '../src/utils/sentryConfig.js';
import { scrubEvent, scrubBreadcrumb, scrubSpan, scrubObject, stripQuery, redactUrl, REDACTED } from '../src/utils/sentryScrub.js';
import { componentName, reportError } from '../src/utils/errorReporting.js';

const DSN = 'https://publickey@o0.ingest.us.sentry.io/4512144722690048';

// --- configuration -----------------------------------------------------------

test('no SENTRYDSN means Sentry stays off', () => {
    assert.equal(buildSentryOptions({}, '1.6.1'), null);
    assert.equal(buildSentryOptions({ SENTRYDSN: '' }, '1.6.1'), null);
    assert.equal(buildSentryOptions({ SENTRYDSN: '   ' }, '1.6.1'), null, 'whitespace is not a DSN');
});

test('SENTRY_DSN with an underscore warns instead of silently staying off', () => {
    // It is Sentry's documented name, and it was typed on the first setup.
    const warnings = [];
    assert.equal(buildSentryOptions({ SENTRY_DSN: DSN }, '1.6.1', m => warnings.push(m)), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SENTRYDSN/);
    const quiet = [];
    buildSentryOptions({}, '1.6.1', m => quiet.push(m));
    assert.equal(quiet.length, 0, 'no DSN at all is a normal state, not a warning');
});

test('release matches package.json and environment follows NODE_ENV', () => {
    const prod = buildSentryOptions({ SENTRYDSN: DSN, NODE_ENV: 'production' }, '1.6.1');
    assert.equal(prod.release, 'biblicana@1.6.1');
    assert.equal(prod.environment, 'production');
    assert.equal(buildSentryOptions({ SENTRYDSN: DSN }, '1.6.1').environment, 'development');
    assert.equal(
        buildSentryOptions({ SENTRYDSN: DSN, NODE_ENV: 'production', SENTRYENVIRONMENT: 'staging' }, '1.6.1').environment,
        'staging', 'explicit SENTRYENVIRONMENT wins'
    );
});

test('the release reads the real package.json version', () => {
    // instrument.js builds the release from package.json; pin that the file
    // has the field it reads, so a malformed bump fails here not in prod.
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.match(version, /^\d+\.\d+\.\d+/);
});

test('privacy settings and scrub hooks are always wired', () => {
    const o = buildSentryOptions({ SENTRYDSN: DSN }, '1.6.1');
    assert.equal(o.sendDefaultPii, false);
    assert.equal(o.beforeSend, scrubEvent);
    assert.equal(o.beforeBreadcrumb, scrubBreadcrumb);
    assert.equal(o.beforeSendSpan, scrubSpan);
    // Sentry 11 streams spans and ignores beforeSendTransaction; setting it
    // would look like span scrubbing while doing nothing.
    assert.equal(o.beforeSendTransaction, undefined);
});

test('sample rates default conservatively and accept overrides', () => {
    const o = buildSentryOptions({ SENTRYDSN: DSN }, '1.6.1');
    assert.equal(o.tracesSampleRate, DEFAULT_TRACES_RATE);
    // Measured volume (tens of interactions a day) makes 100% cheap; see the
    // comment on DEFAULT_TRACES_RATE before lowering it.
    assert.equal(DEFAULT_TRACES_RATE, 1);
    assert.equal(o.profileSessionSampleRate, DEFAULT_PROFILE_RATE);
    assert.equal(o.profileLifecycle, 'trace');

    const custom = buildSentryOptions({ SENTRYDSN: DSN, SENTRYTRACESRATE: '0.25', SENTRYPROFILERATE: '0' }, '1.6.1');
    assert.equal(custom.tracesSampleRate, 0.25);
    assert.equal(custom.profileSessionSampleRate, 0);
});

test('a bad sample rate falls back to the default and warns', () => {
    for (const bad of ['abc', '-0.1', '1.5', 'NaN']) {
        const warnings = [];
        assert.equal(parseRate(bad, 0.1, 'SENTRYTRACESRATE', m => warnings.push(m)), 0.1, bad);
        assert.equal(warnings.length, 1, `must say so for "${bad}"`);
    }
    assert.equal(parseRate(undefined, 0.1, 'X'), 0.1);
    assert.equal(parseRate('0', 0.1, 'X'), 0, 'zero is a valid rate, not a missing one');
    assert.equal(parseRate('1', 0.1, 'X'), 1);
});

// --- scrubbing ---------------------------------------------------------------

test('console breadcrumbs are dropped entirely', () => {
    const logLine = { category: 'console', level: 'info', message: '[AiChat] user asked: what does Romans 9 mean for my brother' };
    assert.equal(scrubBreadcrumb(logLine), null);
});

test('other breadcrumbs keep their shape but lose query strings and text keys', () => {
    const http = {
        category: 'http',
        data: { url: 'https://api.example.com/search?q=my+private+question', method: 'GET', status_code: 200 },
    };
    const out = scrubBreadcrumb(http);
    assert.equal(out.data.url, `https://api.example.com/search?${REDACTED}`);
    assert.equal(out.data.method, 'GET');
    assert.equal(out.data.status_code, 200);

    const withText = scrubBreadcrumb({ category: 'custom', data: { content: 'hello', guild: '123' } });
    assert.equal(withText.data.content, REDACTED);
    assert.equal(withText.data.guild, '123');
});

test('an event loses user, request, and every sensitive key at any depth', () => {
    const event = {
        user: { id: '1', username: 'someone', ip_address: '1.2.3.4' },
        request: { data: 'body text' },
        extra: {
            message: { content: 'the user typed this', author: { username: 'someone', id: '42' } },
            prompt: 'You are Biblicana...',
            guildId: '1167893380341178418',
        },
        contexts: { discord: { channel: '9', cleanContent: 'text', member: { nickname: 'nick', displayName: 'dn' } } },
        tags: { area: 'aichat', guild: '1167893380341178418' },
    };
    const out = scrubEvent(event);
    assert.equal(out.user, undefined);
    assert.equal(out.request, undefined);
    assert.equal(out.extra.message, REDACTED, '"message" is a text key');
    assert.equal(out.extra.prompt, REDACTED);
    assert.equal(out.extra.guildId, '1167893380341178418', 'IDs are kept for tracing an error to its server');
    assert.equal(out.contexts.discord.cleanContent, REDACTED);
    assert.equal(out.contexts.discord.member.nickname, REDACTED);
    assert.equal(out.contexts.discord.member.displayName, REDACTED);
    assert.equal(out.contexts.discord.channel, '9');
    assert.deepEqual(out.tags, event.tags, 'tags are ours and are kept');
});

test('scrubbing never mutates the original event', () => {
    const event = { extra: { content: 'x' }, user: { id: '1' } };
    scrubEvent(event);
    assert.equal(event.extra.content, 'x');
    assert.deepEqual(event.user, { id: '1' });
});

test('breadcrumbs inside an event are filtered the same way', () => {
    const out = scrubEvent({
        breadcrumbs: [
            { category: 'console', message: 'log line with user text' },
            { category: 'http', data: { url: 'https://x.test/a?b=c' } },
        ],
    });
    assert.equal(out.breadcrumbs.length, 1);
    assert.equal(out.breadcrumbs[0].data.url, `https://x.test/a?${REDACTED}`);
});

test('long exception messages are capped but kept', () => {
    const long = 'x'.repeat(2000);
    const out = scrubEvent({ exception: { values: [{ type: 'Error', value: long }, { type: 'Error', value: 'short' }] } });
    assert.ok(out.exception.values[0].value.length < 400);
    assert.match(out.exception.values[0].value, /\[truncated\]$/);
    assert.equal(out.exception.values[1].value, 'short');
});

test('streamed spans lose query strings in name and attributes', () => {
    // Sentry 11's default span shape: { name, attributes }.
    const out = scrubSpan({
        name: 'GET https://api.test/v1?verse=John+3:16',
        is_segment: false,
        attributes: {
            'url.full': 'https://api.test/v1?verse=x',
            'url.query': 'verse=x',
            'http.request.method': 'GET',
            'sentry.op': 'http.client',
        },
    });
    assert.equal(out.name, `GET https://api.test/v1?${REDACTED}`);
    assert.equal(out.attributes['url.full'], `https://api.test/v1?${REDACTED}`);
    assert.equal(out.attributes['url.query'], REDACTED);
    assert.equal(out.attributes['http.request.method'], 'GET');
    assert.equal(out.attributes['sentry.op'], 'http.client');
});

// Shapes taken from the first live trace (2026-09-24), token replaced. The
// real ones decode as "interaction:<id>:<secret>" and let the holder post and
// edit as the bot; a channel webhook's token never expires.
const TOKEN = 'aW50ZXJhY3Rpb246MTU1Mjg4NzExMDUzNTc0NTYyNjpGQUtFVE9LRU4';
const CALLBACK = `https://discord.com/api/v10/interactions/1552887110535745626/${TOKEN}/callback`;
const EDIT = `https://discord.com/api/v10/webhooks/1147654263162544168/${TOKEN}/messages/%40original`;

test('interaction and webhook tokens are redacted from URL paths', () => {
    assert.equal(redactUrl(CALLBACK), `https://discord.com/api/v10/interactions/1552887110535745626/${REDACTED}/callback`);
    assert.equal(redactUrl(EDIT), `https://discord.com/api/v10/webhooks/1147654263162544168/${REDACTED}/messages/%40original`);
    assert.equal(redactUrl(`${CALLBACK}?with_response=false`),
        `https://discord.com/api/v10/interactions/1552887110535745626/${REDACTED}/callback?${REDACTED}`);
    // Routes without a token are untouched.
    const plain = 'https://discord.com/api/v10/channels/1494355280039776329/messages';
    assert.equal(redactUrl(plain), plain);
});

test('a live-shaped http span carries no token in name or any attribute', () => {
    const out = scrubSpan({
        name: `PATCH ${EDIT}`,
        attributes: {
            'url.full': EDIT,
            'url.path': `/api/v10/webhooks/1147654263162544168/${TOKEN}/messages/%40original`,
            'some.future.key': `POST ${CALLBACK}`,
            'http.request.method': 'PATCH',
        },
    });
    assert.doesNotMatch(JSON.stringify(out), new RegExp(TOKEN), 'token must not survive anywhere');
    assert.match(out.name, /webhooks\/1147654263162544168\/\[redacted\]/);
    assert.equal(out.attributes['http.request.method'], 'PATCH');
});

test('breadcrumb URLs lose tokens too', () => {
    const out = scrubBreadcrumb({ category: 'http', data: { url: CALLBACK, method: 'POST' } });
    assert.doesNotMatch(out.data.url, new RegExp(TOKEN));
});

test('command and database spans pass through unchanged in substance', () => {
    const cmd = scrubSpan({ name: '/bible', attributes: { 'sentry.op': 'discord.command' } });
    assert.equal(cmd.name, '/bible');
    const db = scrubSpan({ name: 'SELECT', attributes: { 'db.statement': 'SELECT * FROM guilds WHERE id = $1' } });
    assert.equal(db.attributes['db.statement'], 'SELECT * FROM guilds WHERE id = $1');
    assert.equal(scrubSpan(undefined), undefined);
});

test('an Axios-style config with an API key in headers is redacted', () => {
    const out = scrubObject({ config: { headers: { Authorization: 'Bearer sk-live' }, url: 'https://api.openai.com' } });
    assert.equal(out.config.headers, REDACTED);
});

test('cyclic context does not hang or throw', () => {
    const a = { name: 'a' };
    a.self = a;
    const out = scrubObject(a);
    assert.equal(out.name, 'a');
    assert.equal(out.self, REDACTED);
});

test('stripQuery leaves plain URLs and non-strings alone', () => {
    assert.equal(stripQuery('https://x.test/path'), 'https://x.test/path');
    assert.equal(stripQuery(undefined), undefined);
});

// --- reporting helper --------------------------------------------------------

test('componentName groups parametric custom IDs by their prefix', () => {
    assert.equal(componentName('strongs:Greek:G2316'), 'strongs');
    assert.equal(componentName('config:daily:channel'), 'config');
    assert.equal(componentName('page_next'), 'page_next');
    assert.equal(componentName(''), 'unknown');
    assert.equal(componentName(undefined), 'unknown');
});

test('reportError never throws, with or without Sentry initialised', () => {
    // No instrument.js preload in tests, so the SDK is uninitialised and this
    // exercises the no-op path every catch block relies on.
    assert.doesNotThrow(() => reportError(new Error('x'), { area: 'command', handler: 'bible', guildId: '1' }));
    assert.doesNotThrow(() => reportError(null));
    assert.doesNotThrow(() => reportError({ code: 10062 }, { handler: 'bible' }));
    assert.doesNotThrow(() => reportError('a string'));
});
