import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    MessageFlags,
} from 'discord.js';
import { bibleWrapper } from './bibleHelper.js';
import { accentColor, footerLine } from './theme.js';
import { parseScriptureRefs } from './scriptureRefs.js';
import logger from './logger.js';

// Known BibleBot application IDs. Source of truth is duplicated with
// src/events/guildCreate.js; if this grows beyond one ID, hoist into a
// shared constants module.
const KNOWN_BIBLEBOT_IDS = new Set(['361033318273384449']);

// Max refs to surface per message. Protects the channel from a 10-verse
// quote dump producing 10 button bars; the user can still run /topicalindex
// or /bible for the full range.
const MAX_REFS_PER_MESSAGE = 3;

// How long to wait for BibleBot to post its reply. 3s is comfortably above
// typical Discord bot response latency and well below the threshold where
// users notice the delay.
const BIBLEBOT_WAIT_MS = 3000;

// Max chars of verse text to display in an autopost reply per ref.
const VERSE_DISPLAY_TRUNCATE = 450;

// In-memory dedupe: message IDs we've already processed. Prevents double-
// handling if messageCreate fires twice (it shouldn't, but Discord gonna
// Discord). Entries expire after 10 min — far longer than any reasonable
// replay window.
const processedMessages = new Map();
const PROCESSED_TTL_MS = 10 * 60 * 1000;

function markProcessed(messageId) {
    processedMessages.set(messageId, Date.now());
    if (processedMessages.size > 1000) {
        const cutoff = Date.now() - PROCESSED_TTL_MS;
        for (const [id, ts] of processedMessages) {
            if (ts < cutoff) processedMessages.delete(id);
        }
    }
}

function isProcessed(messageId) {
    const ts = processedMessages.get(messageId);
    if (!ts) return false;
    if (Date.now() - ts > PROCESSED_TTL_MS) {
        processedMessages.delete(messageId);
        return false;
    }
    return true;
}

function refLabel(ref) {
    if (ref.startVerse == null) return `${ref.bookName} ${ref.chapter}`;
    if (ref.endVerse !== ref.startVerse) {
        return `${ref.bookName} ${ref.chapter}:${ref.startVerse}-${ref.endVerse}`;
    }
    return `${ref.bookName} ${ref.chapter}:${ref.startVerse}`;
}

// Build the action row a verse response gets — mirrors the /bible command's
// openverse chain so clicking through passive detection feels identical to
// clicking through a slash command response.
function buildOpenverseRow(ref) {
    // Chapter-only refs use verse=1 as a best-guess anchor. Most chapter
    // intros are chapter-level commentary anyway.
    const anchorVerse = ref.startVerse ?? 1;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Interlinear')
            .setEmoji({ name: '📖' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Commentary')
            .setEmoji({ name: '📚' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Cross-refs')
            .setEmoji({ name: '🔗' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Parallel')
            .setEmoji({ name: '📑' })
            .setStyle(ButtonStyle.Secondary),
    );
}

// Compose the V2 component tree for an autopost reply: one container + one
// action row per ref. Capped at MAX_REFS_PER_MESSAGE so a single message
// quoting many verses doesn't produce a wall of embeds.
async function buildAutopostComponents(refs, translation) {
    const components = [];
    const chosen = refs.slice(0, MAX_REFS_PER_MESSAGE);

    for (const ref of chosen) {
        let verseText = '';
        if (ref.startVerse != null) {
            try {
                const rows = await bibleWrapper.getVerses(
                    ref.bookId, ref.chapter, ref.startVerse, ref.endVerse ?? ref.startVerse
                );
                verseText = rows
                    .map(r => r[translation] || r.BSB || r.KJV)
                    .filter(Boolean)
                    .join(' ');
            } catch (err) {
                logger.warn(`[Passive] Failed to fetch verse text for ${refLabel(ref)}: ${err.message}`);
            }
        }
        if (verseText.length > VERSE_DISPLAY_TRUNCATE) {
            verseText = verseText.slice(0, VERSE_DISPLAY_TRUNCATE - 1) + '…';
        }

        const header = `## 📖 ${refLabel(ref)}${verseText ? ` · ${translation}` : ''}`;
        const body = verseText || '*(chapter-level reference — tap a button for detail)*';

        components.push(new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine('Tap a button for study tools')
            ))
        );
        components.push(buildOpenverseRow(ref));
    }

    if (refs.length > MAX_REFS_PER_MESSAGE) {
        components.push(new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `-# +${refs.length - MAX_REFS_PER_MESSAGE} more reference${refs.length - MAX_REFS_PER_MESSAGE === 1 ? '' : 's'} in this message — use /bible for the rest.`
            ))
        );
    }

    return components;
}

function canSend(channel, me) {
    return channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages);
}

function canReact(channel, me) {
    return channel.permissionsFor(me)?.has(PermissionFlagsBits.AddReactions);
}

async function safeReact(message, emoji) {
    try {
        await message.react(emoji);
    } catch (err) {
        logger.debug(`[Passive] React failed on message ${message.id}: ${err.message}`);
    }
}

// Poll the channel for BibleBot's response after the user's scripture-bearing
// message. Returns BibleBot's message if posted within BIBLEBOT_WAIT_MS, else
// null. Fetches once at the end of the window — Discord's message-fetch
// response includes anything posted during the wait.
async function awaitBibleBotReply(channel, afterMessageId) {
    await new Promise(resolve => setTimeout(resolve, BIBLEBOT_WAIT_MS));
    try {
        const fetched = await channel.messages.fetch({ limit: 10, after: afterMessageId });
        for (const msg of fetched.values()) {
            if (KNOWN_BIBLEBOT_IDS.has(msg.author?.id)) return msg;
        }
    } catch (err) {
        logger.debug(`[Passive] Failed to fetch recent messages in ${channel.id}: ${err.message}`);
    }
    return null;
}

async function userTranslation(database, userId) {
    try {
        const pref = await database.getUserValue(userId);
        if (pref?.translation) return pref.translation;
    } catch { /* noop */ }
    return 'BSB';
}

/**
 * Entry point called from the messageCreate event. Parses scripture refs,
 * dispatches to the right mode's behavior, and marks the message processed.
 */
export async function handleMessageForPassiveDetection(message, mode, database) {
    if (!mode || mode === 'silent') return;
    if (!message.guild) return;                         // DMs: no passive detection
    if (message.author.bot) return;                     // Ignore bots including ourselves
    if (isProcessed(message.id)) return;

    const refs = parseScriptureRefs(message.content);
    if (refs.length === 0) return;

    markProcessed(message.id);

    const me = message.guild.members.me;
    if (!me) return;

    logger.info(
        `[Passive] mode=${mode} guild=${message.guild.id} refs=${refs.length} msg=${message.id}`
    );

    try {
        switch (mode) {
            case 'autopost':
                if (!canSend(message.channel, me)) return;
                await dispatchAutopost(message, refs, database);
                return;
            case 'react_user':
                if (!canReact(message.channel, me)) return;
                await safeReact(message, '📖');
                return;
            case 'react_biblebot':
                if (!canReact(message.channel, me)) return;
                await dispatchReactBibleBot(message);
                return;
            default:
                logger.warn(`[Passive] Unknown mode: ${mode}`);
        }
    } catch (err) {
        logger.error(`[Passive] Handler failed (mode=${mode}, msg=${message.id}): ${err.message}`);
    }
}

async function dispatchAutopost(message, refs, database) {
    const translation = await userTranslation(database, message.author.id);
    const components = await buildAutopostComponents(refs, translation);
    await message.reply({
        flags: MessageFlags.IsComponentsV2,
        components,
        allowedMentions: { repliedUser: false },
    });
}

async function dispatchReactBibleBot(message) {
    const biblebotReply = await awaitBibleBotReply(message.channel, message.id);
    if (biblebotReply) {
        await safeReact(biblebotReply, '📖');
        return;
    }
    // BibleBot didn't post (offline, not configured for this channel, etc.).
    // Fall back to marking the user's message — better than silence, keeps
    // Biblicana's presence visible while the coexistence layer is vacant.
    await safeReact(message, '📖');
}
