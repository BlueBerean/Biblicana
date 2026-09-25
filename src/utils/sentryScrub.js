// What leaves the bot for Sentry, and what does not.
//
// Biblicana sits in ~570 servers and its AI chat carries whatever people type
// at it. `sendDefaultPii: false` stops Sentry attaching IPs and request bodies,
// but it knows nothing about Discord: a message excerpt in an error's context,
// or a username in a log line, is just a string to it. These hooks close that.
//
// The biggest leak is not in any event we build ourselves. Sentry's Console
// integration records every console.* call as a breadcrumb and ships the last
// hundred with each error, and loglevel writes through console — so without
// this, every error would carry the bot's recent log lines, which include AI
// chat excerpts and (with DEBUG_AICHAT_RAG) whole prompts. PM2 already keeps
// those logs; Sentry does not need a second copy.
//
// Kept free of any @sentry import so the tests can exercise it directly.

// Keys whose VALUE is user-written text or identifies a person. Matched
// case-insensitively against the key name alone, anywhere in the event.
// User and guild IDs are deliberately NOT here: a snowflake names an account
// without saying anything about it, and a guild ID is what makes an error
// traceable to the server that reported it.
const SENSITIVE_KEYS = new Set([
    'content', 'cleancontent', 'message', 'messages', 'prompt', 'input',
    'text', 'query', 'body', 'description',
    'username', 'globalname', 'displayname', 'nickname', 'nick', 'tag',
    'discriminator', 'email', 'avatar',
    // An AxiosError's config carries OPENAIKEY in its headers. Sentry only
    // serialises error properties with ExtraErrorData, which is not enabled —
    // this holds if someone enables it later.
    'authorization', 'headers', 'token', 'cookie', 'cookies',
]);

export const REDACTED = '[redacted]';

// Error messages are kept (they are the point of an error report) but capped:
// a thrown message that embeds a user's text is rare, and a long one is the
// shape that usually carries it.
const MAX_EXCEPTION_MESSAGE = 300;

// Guards against cyclic or pathological context objects. Sentry normalises to
// depth 3 by default anyway; nothing useful lives deeper than this.
const MAX_DEPTH = 8;

function scrubValue(value, depth, seen) {
    if (value === null || typeof value !== 'object') return value;
    if (depth > MAX_DEPTH || seen.has(value)) return REDACTED;
    seen.add(value);

    if (Array.isArray(value)) {
        return value.map(v => scrubValue(v, depth + 1, seen));
    }
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
            ? REDACTED
            : scrubValue(v, depth + 1, seen);
    }
    return out;
}

/** Deep-copy `obj` with every sensitive key's value replaced. */
export function scrubObject(obj) {
    return scrubValue(obj, 0, new WeakSet());
}

function capMessage(text) {
    if (typeof text !== 'string' || text.length <= MAX_EXCEPTION_MESSAGE) return text;
    return `${text.slice(0, MAX_EXCEPTION_MESSAGE)}… [truncated]`;
}

// A URL's path names the endpoint; its query string is where a search term or
// a verse the user asked for would ride. Keep the first, drop the second.
export function stripQuery(url) {
    if (typeof url !== 'string') return url;
    const i = url.indexOf('?');
    return i === -1 ? url : `${url.slice(0, i)}?${REDACTED}`;
}

// Discord puts CREDENTIALS in the path, where stripQuery never looks:
//   /interactions/{id}/{token}/callback         interaction token, 15 minutes
//   /webhooks/{application_id}/{token}/...      interaction follow-ups — and,
//                                               for a real channel webhook, a
//                                               token that never expires
// Either lets its holder post and edit as the bot. Found in the first live
// trace (2026-09-24), in span names and url attributes alike; the IDs stay,
// they name the route and are not secret.
const PATH_TOKEN_PATTERNS = [
    /(\/interactions\/\d+\/)[^/?#\s]+/g,
    /(\/webhooks\/\d+\/)[^/?#\s]+/g,
];

/** Strip the query string and redact any Discord token in the path. */
export function redactUrl(url) {
    if (typeof url !== 'string') return url;
    let out = stripQuery(url);
    for (const re of PATH_TOKEN_PATTERNS) out = out.replace(re, `$1${REDACTED}`);
    return out;
}

/**
 * beforeBreadcrumb. Returning null drops the breadcrumb.
 */
export function scrubBreadcrumb(breadcrumb) {
    if (!breadcrumb) return breadcrumb;
    // See the header: console breadcrumbs are the bot's log lines.
    if (breadcrumb.category === 'console') return null;

    const out = { ...breadcrumb };
    if (out.message) out.message = capMessage(out.message);
    if (out.data) {
        out.data = scrubObject(out.data);
        if (out.data.url) out.data.url = redactUrl(out.data.url);
    }
    return out;
}

/**
 * beforeSend (error events). Never returns null: dropping a whole
 * error because it MIGHT hold text would trade a privacy risk for a blind
 * spot, and everything risky in it is removable field by field.
 */
export function scrubEvent(event) {
    if (!event) return event;
    const out = { ...event };

    // No person-level identity at all. sendDefaultPii already withholds the
    // IP; this also removes anything a caller set explicitly.
    delete out.user;
    // There is no inbound HTTP server, so a request block can only have come
    // from an outbound call's context — and would carry its body.
    delete out.request;

    if (out.message) out.message = capMessage(out.message);
    if (out.extra) out.extra = scrubObject(out.extra);
    if (out.contexts) out.contexts = scrubObject(out.contexts);

    if (out.exception?.values) {
        out.exception = {
            ...out.exception,
            values: out.exception.values.map(v => ({ ...v, value: capMessage(v.value) })),
        };
    }

    if (Array.isArray(out.breadcrumbs)) {
        out.breadcrumbs = out.breadcrumbs.map(scrubBreadcrumb).filter(Boolean);
    }

    return out;
}

// Attribute keys that hold an outbound request's URL or its query alone.
const URL_ATTRIBUTES = ['url', 'url.full', 'url.path', 'http.url', 'http.target'];
const QUERY_ATTRIBUTES = ['url.query', 'http.query'];

/**
 * beforeSendSpan. Sentry 11 streams spans one by one by default
 * (traceLifecycle 'stream'), and in that mode beforeSendTransaction is never
 * called — so span scrubbing has to live here, against the streamed shape:
 * `{ name, attributes }`, not the old transaction's `{ description, data }`.
 *
 * pg statements are parameterised and ioredis redacts argument values by
 * default, so what is left is outbound HTTP: an OpenAI or RapidAPI URL whose
 * query string can carry what the user asked for. Must return a span; this
 * hook cannot drop one.
 */
export function scrubSpan(span) {
    if (!span) return span;
    const out = { ...span };
    // An http client span is named "GET <url>": query string and any path
    // token included.
    if (typeof out.name === 'string') out.name = redactUrl(out.name);
    if (out.attributes && typeof out.attributes === 'object') {
        const attrs = scrubObject(out.attributes);
        for (const k of URL_ATTRIBUTES) {
            if (typeof attrs[k] === 'string') attrs[k] = redactUrl(attrs[k]);
        }
        for (const k of QUERY_ATTRIBUTES) {
            if (attrs[k] !== undefined) attrs[k] = REDACTED;
        }
        // Tokens by pattern across EVERY string attribute, not a key list: the
        // key list is what missed url.path the first time. The patterns are
        // specific enough (/interactions/<id>/, /webhooks/<id>/) not to touch
        // anything else.
        for (const [k, v] of Object.entries(attrs)) {
            if (typeof v === 'string' && (v.includes('/interactions/') || v.includes('/webhooks/'))) {
                attrs[k] = redactUrl(v);
            }
        }
        out.attributes = attrs;
    }
    return out;
}
