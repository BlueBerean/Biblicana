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
    // AI chat: admin opt-in per guild. Visible @mention responses are a
    // significant behavior change, so default is OFF — admins must enable.
    // DMs bypass this entirely (users DMing the bot always get AI).
    aiEnabled: joi.boolean().default(false),
    aiMemoryScope: joi.string().valid(...AI_MEMORY_SCOPES).default('channel'),
    dailyVerse: dailyVerseSchema,
});

export default guildModel;
