import {
    Events,
    PermissionFlagsBits,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} from 'discord.js';
import { parseScriptureRefs } from '../utils/scriptureRefs.js';
import { bibleWrapper } from '../utils/bibleHelper.js';
import { toCommentaryVariants, toOSIS3Codes } from '../utils/bookNames.js';
import { fathersWrapper, crossRefWrapper, commentaryWrapper, pickMarqueeFather } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import logger from '../utils/logger.js';

const MARKER_EMOJI = '📖';

// In-memory dedupe: messageIds we've already posted a reaction-expansion
// reply under. Prevents spam if multiple users click 📖 on the same message.
// Lost on restart; post-restart duplicates are acceptable edge cases.
const respondedMessages = new Map();
const RESPONDED_TTL_MS = 24 * 60 * 60 * 1000;

function markResponded(messageId) {
    respondedMessages.set(messageId, Date.now());
    if (respondedMessages.size > 2000) {
        const cutoff = Date.now() - RESPONDED_TTL_MS;
        for (const [id, ts] of respondedMessages) {
            if (ts < cutoff) respondedMessages.delete(id);
        }
    }
}

function alreadyResponded(messageId) {
    const ts = respondedMessages.get(messageId);
    if (!ts) return false;
    if (Date.now() - ts > RESPONDED_TTL_MS) {
        respondedMessages.delete(messageId);
        return false;
    }
    return true;
}

const VERSE_DISPLAY_TRUNCATE = 450;

function refLabel(ref) {
    if (ref.startVerse == null) return `${ref.bookName} ${ref.chapter}`;
    if (ref.endVerse !== ref.startVerse) {
        return `${ref.bookName} ${ref.chapter}:${ref.startVerse}-${ref.endVerse}`;
    }
    return `${ref.bookName} ${ref.chapter}:${ref.startVerse}`;
}

// Pull verse text + study-tool stats in parallel. Each query is ~O(ms) on
// local SQLite; Promise.all bounds wall-clock by the slowest (usually fathers
// because its query joins father_meta). Returns a shape friendly to the
// renderer — null / 0 fields mean "skip that stat line segment".
async function fetchExpansionData(ref, translation) {
    if (ref.startVerse == null) {
        // Chapter-only refs: no verse text, no stats. Minimal expansion.
        return { verseText: '', commentatorCount: 0, fathersCount: 0, topFather: null, xrefCount: 0 };
    }

    const [verseRows, fathers, xrefs, commentatorCount] = await Promise.all([
        bibleWrapper.getVerses(ref.bookId, ref.chapter, ref.startVerse, ref.endVerse ?? ref.startVerse)
            .catch(() => []),
        fathersWrapper.getByPassage(toCommentaryVariants(ref.bookName), ref.chapter, ref.startVerse)
            .catch(() => []),
        crossRefWrapper.getForVerse(ref.bookName, ref.chapter, ref.startVerse)
            .catch(() => []),
        commentaryWrapper.countCommentatorsForVerse(toOSIS3Codes(ref.bookId), ref.chapter, ref.startVerse)
            .catch(() => 0),
    ]);

    let verseText = verseRows
        .map(r => r[translation] || r.BSB || r.KJV)
        .filter(Boolean)
        .join(' ');
    if (verseText.length > VERSE_DISPLAY_TRUNCATE) {
        verseText = verseText.slice(0, VERSE_DISPLAY_TRUNCATE - 1) + '…';
    }

    return {
        verseText,
        commentatorCount,
        fathersCount: fathers.length,
        // Marquee-first pick over alphabetical default. If a big-name Father
        // wrote on this verse (Augustine, Chrysostom, Aquinas, etc.), surface
        // them rather than whoever happens to come first in ASCII order.
        topFather: pickMarqueeFather(fathers),
        xrefCount: xrefs.length,
    };
}

async function buildExpansionReply(ref, translation) {
    const anchorVerse = ref.startVerse ?? 1;
    const data = await fetchExpansionData(ref, translation);

    const statSegments = [];
    if (data.commentatorCount > 0) {
        statSegments.push(`📚 ${data.commentatorCount} commentator${data.commentatorCount === 1 ? '' : 's'}`);
    }
    if (data.topFather) {
        const remainder = data.fathersCount - 1;
        statSegments.push(remainder > 0
            ? `📜 ${data.topFather} + ${remainder} other Father${remainder === 1 ? '' : 's'}`
            : `📜 ${data.topFather}`);
    }
    if (data.xrefCount > 0) {
        statSegments.push(`🔗 ${data.xrefCount} cross-reference${data.xrefCount === 1 ? '' : 's'}`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `## 📖 ${refLabel(ref)}${data.verseText ? ` · ${translation}` : ''}`
        ));

    if (data.verseText) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(data.verseText));
    }

    if (statSegments.length > 0) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${statSegments.join(' · ')}`
        ));
    }

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        footerLine('Tap a button for the full study view · ephemeral')
    ));

    // Five buttons: openverse chain + Fathers. 5 is the Discord action-row
    // button cap; if we ever want a sixth action (topical index, prophecy
    // link), we'll need a second action row or a StringSelectMenu instead.
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`openverse:interlinear:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Interlinear').setEmoji({ name: '📖' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:commentary:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Commentary').setEmoji({ name: '📚' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:xref:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Cross-refs').setEmoji({ name: '🔗' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:parallel:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Parallel').setEmoji({ name: '📑' }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`openverse:fathers:${ref.bookId}:${ref.chapter}:${anchorVerse}`)
            .setLabel('Fathers').setEmoji({ name: '📜' }).setStyle(ButtonStyle.Secondary),
    );
    return { flags: MessageFlags.IsComponentsV2, components: [container, actionRow] };
}

// Recursively pull `.content` strings from V2 Components (TextDisplay nodes
// nested in Containers / Sections). V2 messages leave `message.content` and
// `message.embeds` both empty — the text lives only in the component tree,
// so without this traversal any bot-posted V2 message looks like empty text
// to the parser. Duck-types both plain-object (raw REST response) and
// discord.js class-instance shapes (`.data` wrap).
function extractComponentText(components) {
    if (!components) return [];
    const items = Array.isArray(components) ? components : Array.from(components.values?.() ?? []);
    const out = [];
    for (const c of items) {
        const type = c?.type ?? c?.data?.type;
        const content = c?.content ?? c?.data?.content;
        // Type 10 = TextDisplay; Type 4 = legacy TextInput (modals only, but
        // has content too so no harm in catching it).
        if ((type === 10 || type === 4) && typeof content === 'string') out.push(content);
        const nested = c?.components ?? c?.data?.components;
        if (nested) out.push(...extractComponentText(nested));
    }
    return out;
}

// Extract searchable text from a message — content, embed text, AND V2
// component text. Needed so 📖 clicks work on BibleBot-style embed messages,
// plain user messages, and V2-formatted bot messages (including Biblicana's
// own autopost replies and welcome cards).
function extractSearchText(message) {
    const parts = [message.content || ''];
    for (const embed of message.embeds || []) {
        if (embed.title) parts.push(embed.title);
        if (embed.description) parts.push(embed.description);
        if (embed.author?.name) parts.push(embed.author.name);
        for (const field of embed.fields || []) {
            if (field.name) parts.push(field.name);
            if (field.value) parts.push(field.value);
        }
    }
    parts.push(...extractComponentText(message.components));
    return parts.join(' ');
}

// Reaction-click handler for the 📖 marker. When a user reacts with 📖 to a
// message containing a scripture reference, post a threaded reply under it
// with the openverse action row — gives one-click access to the full study
// tools without requiring the clicker to know the slash commands.
//
// Triggers on any user's 📖 reaction, not just on messages Biblicana marked.
// That means users in `silent` mode guilds cannot summon expansion via
// reaction — we respect admin intent. Other modes all allow it.
export default {
    name: Events.MessageReactionAdd,
    async execute(reaction, user, database) {
        try {
            // Fast-path rejects: cheapest checks first, no logging. Most
            // reactions across a busy guild are non-📖 or bot-authored, and
            // this handler runs on every single one.
            if (user.bot) return;
            if (reaction.emoji?.name !== MARKER_EMOJI) return;

            // Partial handling: fetch full reaction + message if needed.
            // Debug-level on failure keeps quiet in prod but available in dev.
            if (reaction.partial) {
                try { await reaction.fetch(); } catch (err) {
                    return logger.debug(`[PassiveReaction] partial reaction fetch failed: ${err.message}`);
                }
            }
            const message = reaction.message;
            if (message.partial) {
                try { await message.fetch(); } catch (err) {
                    return logger.debug(`[PassiveReaction] partial message fetch failed: ${err.message}`);
                }
            }

            if (!message.guild) return;
            if (alreadyResponded(message.id)) return;

            // Note: silent-mode guilds are NOT blocked here anymore — a user
            // clicking 📖 is explicit solicitation, which silent mode doesn't
            // preclude. Silent still blocks unsolicited passive detection in
            // src/events/messageCreate.js, which is the right scope for it.
            const me = message.guild.members.me;
            if (!me) return;
            if (!message.channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) return;

            const refs = parseScriptureRefs(extractSearchText(message));
            if (refs.length === 0) return;

            markResponded(message.id);

            const ref = refs.find(r => r.startVerse != null) ?? refs[0];
            logger.info(`[PassiveReaction] posting ref=${refLabel(ref)} guild=${message.guild.id} clicker=${user.id}`);

            // Resolve the clicker's preferred translation so the verse text
            // matches what they'd get via /bible or /randomverse.
            let translation = 'BSB';
            try {
                const pref = await database.getUserValue(user.id);
                if (pref?.translation) translation = pref.translation;
            } catch { /* default */ }

            const reply = await buildExpansionReply(ref, translation);
            await message.reply({
                ...reply,
                allowedMentions: { repliedUser: false },
            });
        } catch (err) {
            logger.error(`[PassiveReaction] Unhandled: ${err.message}`);
        }
    },
};
