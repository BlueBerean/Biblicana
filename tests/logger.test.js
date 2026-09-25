// Coverage for the log level. NODE_ENV must be "production" on the droplet
// for Sentry and the heartbeat, but some diagnostic trails live only at debug;
// LOGLEVEL overrides the level without changing what Sentry is told.
//
// NOTE: test names stay ASCII (see the note in heartbeat.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLevel } from '../src/utils/logger.js';

test('production defaults to info and everything else to debug', () => {
    assert.deepEqual(resolveLevel({ NODE_ENV: 'production' }), { level: 'info' });
    assert.deepEqual(resolveLevel({}), { level: 'debug' });
    assert.deepEqual(resolveLevel({ NODE_ENV: 'development' }), { level: 'debug' });
});

test('LOGLEVEL overrides either default, case-insensitively', () => {
    assert.equal(resolveLevel({ NODE_ENV: 'production', LOGLEVEL: 'debug' }).level, 'debug');
    assert.equal(resolveLevel({ LOGLEVEL: 'WARN' }).level, 'warn');
});

test('an unknown LOGLEVEL falls back and says so', () => {
    const r = resolveLevel({ NODE_ENV: 'production', LOGLEVEL: 'verbose' });
    assert.equal(r.level, 'info');
    assert.match(r.warning, /LOGLEVEL="verbose"/);
});
