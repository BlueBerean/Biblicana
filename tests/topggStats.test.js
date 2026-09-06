// Coverage for the top.gg server-count poster.
//
// Top.gg does NOT read the guild count from Discord - its docs say to post
// "whenever your bot's server count changes" - so a bot that never posts shows
// no server count at all, which is what Biblicana did while sitting in 500+
// servers. Other bots only look automatic because they post too, usually via
// @top-gg/sdk's AutoPoster.
//
// The whole risk here is that a listing-cosmetic feature must never affect the
// bot: a top.gg outage, a rotated token or a hung socket has to stay contained.
// Most of these tests are about that rather than the happy path.
//
// NOTE: test names stay ASCII - prod's Node 18.13 TAP lexer dies on non-ASCII
// in a test() description and reports the whole file as 0 passed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import log from 'loglevel';

log.setLevel('error');

import { postGuildCount, startTopggPoster } from '../src/utils/topggStats.js';

const fakeClient = (guildCount, id = '1165716269425758249') => ({
    user: { id },
    guilds: { cache: { size: guildCount } },
});

// Swap global fetch for the duration of one call.
async function withFetch(impl, fn) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return impl(url, opts);
    };
    try {
        return { result: await fn(), calls };
    } finally {
        globalThis.fetch = original;
    }
}

const ok = async () => ({ ok: true, status: 200 });

test('posts the guild count to the documented endpoint', async () => {
    process.env.TOPGGTOKEN = 'test-token';
    const { result, calls } = await withFetch(ok, () => postGuildCount(fakeClient(572)));
    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://top.gg/api/bots/1165716269425758249/stats');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { server_count: 572 });
});

test('sends the token bare, with no Bearer prefix', async () => {
    // top.gg is unusual here; a Bearer prefix is rejected as unauthorized, and
    // the only symptom is a listing that silently never updates.
    process.env.TOPGGTOKEN = 'test-token';
    const { calls } = await withFetch(ok, () => postGuildCount(fakeClient(572)));
    assert.equal(calls[0].opts.headers.Authorization, 'test-token');
    assert.doesNotMatch(calls[0].opts.headers.Authorization, /^Bearer /);
});

test('an empty guild cache posts nothing rather than posting zero', async () => {
    // READY populates the cache; posting before that would publish a wrong
    // number, which is worse than the no number top.gg already shows.
    process.env.TOPGGTOKEN = 'test-token';
    const { result, calls } = await withFetch(ok, () => postGuildCount(fakeClient(0)));
    assert.equal(result, false);
    assert.equal(calls.length, 0, 'must not call top.gg with a count of 0');
});

test('a rejected token does not throw', async () => {
    process.env.TOPGGTOKEN = 'wrong-token';
    const { result } = await withFetch(
        async () => ({ ok: false, status: 401 }),
        () => postGuildCount(fakeClient(572))
    );
    assert.equal(result, false, 'reports failure without raising');
});

test('a network failure does not throw', async () => {
    // A top.gg outage must not reach anything the bot does for its own users.
    process.env.TOPGGTOKEN = 'test-token';
    const { result } = await withFetch(
        async () => { throw new Error('getaddrinfo ENOTFOUND top.gg'); },
        () => postGuildCount(fakeClient(572))
    );
    assert.equal(result, false);
});

test('no token means no poster and no requests', async () => {
    // The normal state for the test bot, which has no top.gg listing at all.
    delete process.env.TOPGGTOKEN;
    const { result, calls } = await withFetch(ok, async () => startTopggPoster(fakeClient(572)));
    assert.equal(result, null, 'returns no handle to clear');
    assert.equal(calls.length, 0);
});

test('a running poster returns a handle the shutdown path can clear', async () => {
    process.env.TOPGGTOKEN = 'test-token';
    const { result } = await withFetch(ok, async () => startTopggPoster(fakeClient(572)));
    assert.notEqual(result, null, 'shutdown needs a handle to clearInterval');
    clearInterval(result);
    delete process.env.TOPGGTOKEN;
});
