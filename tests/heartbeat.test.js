// Coverage for the heartbeat (a Sentry Cron Monitor check-in).
//
// The heartbeat is a dead-man's switch: Sentry alerts when check-ins STOP.
// So the tests that matter are the ones proving it goes quiet when the bot is
// not genuinely connected - a heartbeat that checks in through an outage is worse
// than none, because it reports the outage as healthy.
//
// The subtle case is the dropped gateway. discord.js 14 latches the manager's
// status to Ready on first READY and never resets it, so isReady() stays true
// while a shard is reconnecting. Only the per-shard status moves. Several
// tests below build exactly that state.
//
// NOTE: test names stay ASCII - prod's Node 18.13 TAP lexer died on non-ASCII
// in a test() description; kept as the rule after the move to Node 22.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';
import { Status } from 'discord.js';

log.setLevel('silent');

import {
    isGatewayHealthy,
    sendHeartbeat,
    startHeartbeat,
    heartbeatEnabled,
    MONITOR_CONFIG,
    MONITOR_SLUG,
    HEARTBEAT_INTERVAL_MS,
    _resetHeartbeatState,
} from '../src/utils/heartbeat.js';

// A client shaped like discord.js's: isReady() is the manager-level check,
// ws.shards a Collection (a Map) of shards with their own status.
function fakeClient({ ready = true, shardStatuses = [Status.Ready] } = {}) {
    const shards = new Map(shardStatuses.map((status, id) => [id, { id, status }]));
    return {
        isReady: () => ready,
        ws: { status: ready ? Status.Ready : Status.Idle, shards },
    };
}

// Records check-ins instead of sending them.
function recorder() {
    const calls = [];
    const fn = () => { calls.push(Date.now()); };
    fn.calls = calls;
    return fn;
}

beforeEach(() => _resetHeartbeatState());

test('healthy when logged in and every shard is Ready', () => {
    assert.equal(isGatewayHealthy(fakeClient()), true);
    assert.equal(isGatewayHealthy(fakeClient({ shardStatuses: [Status.Ready, Status.Ready] })), true);
});

test('not healthy before login', () => {
    assert.equal(isGatewayHealthy(fakeClient({ ready: false })), false);
});

test('not healthy while a shard reconnects even though isReady is still true', () => {
    // The case the handoff's suggested check (isReady plus ws.status) misses:
    // the manager status latches Ready, so both of those stay true here.
    const client = fakeClient({ ready: true, shardStatuses: [Status.Connecting] });
    assert.equal(client.isReady(), true, 'precondition: manager still reports ready');
    assert.equal(client.ws.status, Status.Ready, 'precondition: manager status latched');
    assert.equal(isGatewayHealthy(client), false);
});

test('not healthy while resuming, disconnected, or with one bad shard of two', () => {
    for (const s of [Status.Resuming, Status.Disconnected, Status.Identifying, Status.Reconnecting]) {
        assert.equal(isGatewayHealthy(fakeClient({ shardStatuses: [s] })), false, `status ${Status[s]}`);
    }
    assert.equal(isGatewayHealthy(fakeClient({ shardStatuses: [Status.Ready, Status.Resuming] })), false);
});

test('no shards at all is not healthy', () => {
    // Array.every over nothing is true; the check must not read "no shards"
    // as "all shards ready".
    assert.equal(isGatewayHealthy(fakeClient({ shardStatuses: [] })), false);
});

test('a missing or malformed client is not healthy and does not throw', () => {
    assert.equal(isGatewayHealthy(undefined), false);
    assert.equal(isGatewayHealthy({}), false);
    assert.equal(isGatewayHealthy({ isReady: () => true }), false);
});

test('checks in when healthy', () => {
    const checkIn = recorder();
    assert.equal(sendHeartbeat(fakeClient(), checkIn), true);
    assert.equal(checkIn.calls.length, 1);
});

test('withholds the check-in when the gateway is down', () => {
    const checkIn = recorder();
    assert.equal(sendHeartbeat(fakeClient({ shardStatuses: [Status.Resuming] }), checkIn), false);
    assert.equal(checkIn.calls.length, 0, 'a withheld check-in is how the alert fires');
});

test('withholds the check-in when the client is not ready', () => {
    const checkIn = recorder();
    assert.equal(sendHeartbeat(fakeClient({ ready: false }), checkIn), false);
    assert.equal(checkIn.calls.length, 0);
});

test('resumes checking in once the gateway recovers', () => {
    const checkIn = recorder();
    const client = fakeClient({ shardStatuses: [Status.Connecting] });
    sendHeartbeat(client, checkIn);
    assert.equal(checkIn.calls.length, 0);
    client.ws.shards.get(0).status = Status.Ready;
    assert.equal(sendHeartbeat(client, checkIn), true);
    assert.equal(checkIn.calls.length, 1);
});

test('a throwing check-in does not throw into the bot', () => {
    const boom = () => { throw new Error('transport exploded'); };
    assert.equal(sendHeartbeat(fakeClient(), boom), false);
});

test('only production with Sentry running checks in', () => {
    // A heartbeat treats silence as the alarm: a dev bot checking in would
    // page someone every time it was stopped for the night.
    assert.equal(heartbeatEnabled({ sentryInitialized: true, environment: 'production' }), true);
    assert.equal(heartbeatEnabled({ sentryInitialized: true, environment: 'development' }), false);
    assert.equal(heartbeatEnabled({ sentryInitialized: true, environment: undefined }), false);
    assert.equal(heartbeatEnabled({ sentryInitialized: false, environment: 'production' }), false);
});

test('off outside production means no timer and no check-ins', () => {
    const checkIn = recorder();
    assert.equal(startHeartbeat(fakeClient(), { sentryInitialized: true, environment: 'development', checkIn }), null);
    assert.equal(startHeartbeat(fakeClient(), { sentryInitialized: false, environment: 'production', checkIn }), null);
    assert.equal(checkIn.calls.length, 0);
});

test('in production it checks in at once and returns a clearable handle', () => {
    const checkIn = recorder();
    const handle = startHeartbeat(fakeClient(), { sentryInitialized: true, environment: 'production', checkIn });
    assert.notEqual(handle, null, 'shutdown needs a handle to clearInterval');
    assert.equal(checkIn.calls.length, 1, 'checks in immediately on start');
    clearInterval(handle);
});

test('the monitor schedule matches the tick interval', () => {
    // If these drift apart, Sentry expects check-ins at a different rate
    // than the bot sends them: every tick reads as late, or outages as fine.
    assert.equal(MONITOR_CONFIG.schedule.type, 'interval');
    assert.equal(MONITOR_CONFIG.schedule.unit, 'minute');
    assert.equal(MONITOR_CONFIG.schedule.value * 60000, HEARTBEAT_INTERVAL_MS);
    assert.ok(MONITOR_CONFIG.failureIssueThreshold >= 2, 'one blip must not page');
    assert.equal(MONITOR_SLUG, 'biblicana-gateway');
});
