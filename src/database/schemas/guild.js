import joi from 'joi';

// Passive scripture-detection modes. `react_biblebot` is the default — it's
// the one coexistence-safe option in servers that already run BibleBot.
export const PASSIVE_MODES = ['silent', 'react_biblebot', 'react_user', 'autopost'];

// AI memory scope:
//   'channel' — shared thread per channel. Multiple users in the same
//               channel see a continuous conversation. Good for group Bible
//               study; default for new guilds.
//   'user'    — private thread per user. Each user's chat with Biblicana
//               is isolated. Better for intimate/small servers where
//               privacy of questions matters.
export const AI_MEMORY_SCOPES = ['channel', 'user'];

// Daily Verse of the Day auto-post config. All fields optional so the object
// can exist in a "partially configured" state (e.g., admin set a channel
// but hasn't picked an hour yet) without failing schema validation.
const dailyVerseSchema = joi.object({
    enabled: joi.boolean().default(false),
    channelId: joi.string().allow(null, ''),
    hour: joi.number().integer().min(0).max(23).allow(null),
    lastPostedDate: joi.string().allow(null, ''),   // ISO date (YYYY-MM-DD), used for dedupe
}).default({ enabled: false });

const guildModel = joi.object({
    id: joi.string().required(),
    passiveMode: joi.string().valid(...PASSIVE_MODES).default('react_biblebot'),
    // Passive-detection channel allowlist, same semantics as aiChannels below.
    // EMPTY = scan in EVERY channel the bot can read (the default, and what
    // every guild configured before this existed already had). When NON-EMPTY,
    // passive detection only runs in these channel IDs; threads inherit their
    // parent.
    //
    // Narrows processing rather than expanding it, which is why adding it did
    // not require a Terms re-acknowledgment. The Privacy Policy has described
    // passive detection as channel-scoped since before this field existed
    // (Sections 1 and 1.7) — this is the code catching up to the disclosure.
    passiveChannels: joi.array().items(joi.string()).default([]),
    // Autopost layout. FALSE (default) posts a card per reference, up to three,
    // with a "+N more" note beyond that. TRUE posts ONE card with prev/next
    // buttons and drops the three-reference cap, so a message quoting twenty
    // verses becomes a browsable pager instead of a wall or a truncation.
    //
    // Only affects the 'autopost' mode; the react-only modes post nothing to
    // lay out.
    passivePaginate: joi.boolean().default(false),
    // Who the page buttons move. TRUE (default) gives each reader their own
    // private pager, so two people browsing the same post don't tug the view
    // between them; the public post stays on the first reference. FALSE makes
    // the buttons move the public message for everyone, which keeps a channel
    // reading together at the cost of that contention.
    //
    // Only meaningful when passivePaginate is on — the card layout has no
    // buttons to move.
    //
    // NOTE: this one DEFAULTS TRUE, so readers must not use Boolean(value) —
    // an unset field would read as false and silently flip the default. See
    // readPassivePagerPrivate.
    passivePagerPrivate: joi.boolean().default(true),
    // How much of a passage an auto-post card shows before it stops. A STRING
    // rather than a boolean specifically to sidestep the trap documented above:
    // the sensible default is the permissive one, and a boolean defaulting TRUE
    // reads as false when unset. Only the exact value 'compact' opts out, so an
    // absent field needs no coercion to mean 'full'.
    //
    // Neither value can mean "never cut" — Discord caps a V2 component tree at
    // 4000 characters and half of all chapters exceed even 3000 — which is why
    // a truncated card carries a Read full button instead.
    passiveDetail: joi.string().valid('full', 'compact').default('full'),
    // AI chat: admin opt-in per guild. Visible @mention responses are a
    // significant behavior change, so default is OFF — admins must enable.
    // (DM AI chat is currently disabled — see FOLLOWUPS.md "DM AI chat".)
    aiEnabled: joi.boolean().default(false),
    aiMemoryScope: joi.string().valid(...AI_MEMORY_SCOPES).default('channel'),
    // AI chat channel allowlist. EMPTY = allowed in ALL channels (the default,
    // and backward-compatible with guilds configured before this existed). When
    // NON-EMPTY, the @mention/reply AI conversation only fires in these channel
    // IDs (threads inherit their parent). Slash commands (/find, /web, etc.) are
    // NOT affected — they work everywhere regardless of this list.
    aiChannels: joi.array().items(joi.string()).default([]),
    // AI chat role DENYLIST — the inverse of aiChannels. EMPTY = nobody denied
    // (the default, and backward-compatible with guilds configured before this
    // existed). When NON-EMPTY, a member holding any of these roles gets no
    // response from the @mention/reply conversation. Built for servers that
    // want a "No AI" role they can hand out.
    //
    // Members with Manage Server are exempt, so an admin cannot lock themselves
    // out of a bot they administer.
    //
    // Slash commands are NOT affected — Discord's own per-command permissions
    // (Server Settings -> Integrations) already cover those, and cover them
    // more reliably since Discord enforces before the interaction reaches us.
    aiDeniedRoles: joi.array().items(joi.string()).default([]),
    // AI chat role REQUIREMENT. EMPTY = no requirement (the default). When
    // NON-EMPTY, a member must hold at least one of these roles for the
    // @mention/reply conversation to respond at all.
    //
    // aiDeniedRoles OVERRULES this: holding a denied role blocks a member even
    // if they also hold a required one, so a "No AI" role stays authoritative
    // without an admin having to unpick every other role assignment.
    //
    // Manage Server bypasses BOTH lists.
    aiRequiredRoles: joi.array().items(joi.string()).default([]),
    dailyVerse: dailyVerseSchema,
});

export default guildModel;
