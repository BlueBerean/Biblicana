import {
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
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

// Verse-text budget for ONE autopost message, shared across the cards in it.
//
// This replaced a flat 450 chars PER CARD, which was sized for the worst case —
// three cards in one message — and then charged to every post regardless. In
// production 70% of posts carry exactly one reference, so most of the time a
// single card was rationed to a third of the space while ~3500 characters of
// Discord's 4000-char V2 component tree went unused.
//
// It matters more than it sounds. No verse in the BSB reaches 450 characters
// (the longest is 400), so single verses were never the problem — but 1182 of
// the Bible's 1189 chapters exceed it, and the median chapter is 3032, so
// someone typing "Romans 8" saw about 15% of it and an ellipsis. An average
// five-verse range is ~612 and was cut too.
//
// Split across the cards actually present, floored so three references still
// each get a readable amount rather than a sentence.
const AUTOPOST_BUDGET_FULL = 2400;
const AUTOPOST_BUDGET_COMPACT = 1050;
const AUTOPOST_MIN_PER_REF = 300;

// Per-page budget in the full-passage reader. It owns an ephemeral message
// outright — no other cards, no jump menu — so it can spend more than a
// shared page.
const PASSAGE_PAGE_BUDGET = 3200;

/** Chars of verse text one autopost card may use, given how many share the message. */
export function autopostLimitFor(refCount, detail = 'full') {
    const total = detail === 'compact' ? AUTOPOST_BUDGET_COMPACT : AUTOPOST_BUDGET_FULL;
    return Math.max(AUTOPOST_MIN_PER_REF, Math.floor(total / Math.max(1, refCount)));
}

// The paginated layout shows ONE reference per message, so it gets a far larger
// budget. Bounded well under Discord's 4000-char ceiling for a V2 component
// tree, leaving room for the heading, footer and both button rows.
const PAGE_DISPLAY_TRUNCATE = 3000;

// Upper bound for a whole-chapter fetch. The longest chapter in the Bible is
// Psalm 119 at 176 verses, so this clears it comfortably; the query is a
// BETWEEN, so asking for more verses than exist simply returns fewer rows.
const CHAPTER_VERSE_CEILING = 200;

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

// Address of a passage for the full-text reader. Chapter-only references carry
// 0 for both verses, which is what tells the reader to page the whole chapter.
export function passageCustomId(ref) {
    return `passageread:${ref.bookId}:${ref.chapter}:${ref.startVerse ?? 0}:${ref.endVerse ?? 0}`;
}

// Build the action row a verse response gets — mirrors the /bible command's
// openverse chain so clicking through passive detection feels identical to
// clicking through a slash command response.
function buildOpenverseRow(ref, { truncated = false } = {}) {
    // Chapter-only refs use verse=1 as a best-guess anchor. Most chapter
    // intros are chapter-level commentary anyway.
    const anchorVerse = ref.startVerse ?? 1;
    const row = new ActionRowBuilder().addComponents(
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

    // Only when something was actually cut. A row that always carried it would
    // promise more text on cards that are already showing all of it. Primary
    // style because on a truncated card this is the button the reader wants —
    // the other four lead away from the passage, not further into it.
    // Five is Discord's per-row maximum, so this row is now full.
    if (truncated) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(passageCustomId(ref))
                .setLabel('Read full')
                .setEmoji({ name: '📜' })
                .setStyle(ButtonStyle.Primary)
        );
    }

    return row;
}

// Compose the V2 component tree for an autopost reply: one container + one
// action row per ref. Capped at MAX_REFS_PER_MESSAGE so a single message
// quoting many verses doesn't produce a wall of embeds.
async function buildAutopostComponents(refs, translation, detail = 'full') {
    const components = [];
    const chosen = refs.slice(0, MAX_REFS_PER_MESSAGE);
    // Sized by what is actually in THIS message, not by the worst case.
    const limit = autopostLimitFor(chosen.length, detail);

    for (const ref of chosen) {
        const { text: verseText, truncated } = await verseTextDetailed(ref, translation, limit);
        const header = `## 📖 ${refLabel(ref)}${verseText ? ` · ${translation}` : ''}`;
        const body = verseText || '*(couldn\'t load the text for this reference — tap a button for study tools)*';

        components.push(new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine(truncated ? 'Tap Read full for the whole passage' : 'Tap a button for study tools')
            ))
        );
        components.push(buildOpenverseRow(ref, { truncated }));
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

// Hard ceiling on a paginated post. Set by Discord's StringSelectMenu limit of
// 25 options, NOT chosen freely: the jump menu lists every reference in the
// pager, and a cap above 25 would make "the menu lists everything" false.
// Twenty-five references in one message is already far past any real quote.
const MAX_REFS_PAGINATED = 25;

// References per page in the PRIVATE view. Three is the target; a page holds
// fewer when the text won't fit, and always holds at least one.
const MAX_REFS_PER_PRIVATE_PAGE = 3;

// Combined verse-text budget for one private page, across all references on it.
// Bounded under Discord's 4000-char ceiling for a V2 component tree, leaving
// room for headings, the jump menu, the pager and the study-tool rows.
const PRIVATE_PAGE_BUDGET = 2600;

// Rough per-reference chrome cost (heading + footer) charged against the budget
// when deciding how many fit, so grouping accounts for more than raw verse text.
const PRIVATE_PAGE_REF_OVERHEAD = 70;

// Discord caps a Components V2 message at 10 top-level components. A private
// page spends: 1 container + 1 study row per reference, + jump menu + pager.
// Three references is 8, which fits — this is the backstop that keeps a future
// edit from silently building an unsendable message.
const MAX_TOP_LEVEL_COMPONENTS = 10;

/**
 * Fetch and format the verse text for one reference. Shared by both layouts so
 * a paginated page and a card show identical text for the same verse.
 *
 * A MULTI-VERSE range gets bold verse numbers — "**1** In the beginning… **2**
 * Now the earth…" — because without them a range reads as one run-on paragraph
 * and a reader can't tell where verse 1 ends and verse 2 begins. A single verse
 * gets none: the number is already in the heading, and repeating it inline just
 * adds noise.
 *
 * `limit` differs by layout. A card shares its message with up to two other
 * cards, so it stays tight; a pager page owns the whole message and can afford
 * far more, which matters for the ranges pagination exists to show (1 Cor
 * 15:1-58 at the card budget was three sentences and an ellipsis).
 */
async function verseTextFor(ref, translation, limit = AUTOPOST_BUDGET_FULL) {
    const { text } = await verseTextDetailed(ref, translation, limit);
    return text;
}

/**
 * As `verseTextFor`, but also reports whether anything was cut.
 *
 * The flag is what lets a card offer a way through instead of ending at an
 * ellipsis. Before this, a truncated card's only buttons were Interlinear,
 * Commentary, Cross-refs and Parallel — every one of which navigates AWAY to a
 * different view, so there was no route to the rest of the passage at all. A
 * server admin removed Biblicana's permissions over exactly that.
 */
async function verseTextDetailed(ref, translation, limit = AUTOPOST_BUDGET_FULL) {
    try {
        // A chapter-level reference ("John 1", "John 1:-") has no start verse.
        // Fetch the WHOLE chapter and let the truncation budget decide how much
        // shows — previously this returned nothing at all and the card said
        // "tap a button for detail", which is a worse answer than the opening
        // of the chapter the user actually named.
        const isChapterOnly = ref.startVerse == null;
        const from = isChapterOnly ? 1 : ref.startVerse;
        const to = isChapterOnly ? CHAPTER_VERSE_CEILING : (ref.endVerse ?? ref.startVerse);

        const rows = await bibleWrapper.getVerses(ref.bookId, ref.chapter, from, to);
        const verses = rows
            .map(r => ({ number: r.verse, text: r[translation] || r.BSB || r.KJV }))
            .filter(v => Boolean(v.text));

        const text = verses.length > 1
            ? verses.map(v => `**${v.number}** ${v.text}`).join(' ')
            : verses.map(v => v.text).join(' ');

        if (text.length > limit) {
            return { text: text.slice(0, limit - 1) + '…', truncated: true };
        }
        return { text, truncated: false };
    } catch (err) {
        logger.warn(`[Passive] Failed to fetch verse text for ${refLabel(ref)}: ${err.message}`);
        return { text: '', truncated: false };
    }
}

/**
 * Split ONE reference into pages, breaking on verse boundaries.
 *
 * This is the thing the existing pager cannot do. `computePageGroups` groups
 * whole REFERENCES onto pages and never splits one, so "Romans 8" is a single
 * reference, a single page, and still truncated — paging across references
 * doesn't help when the message only had one. Half of all chapters exceed even
 * the generous 3000-char page budget, so a reader has to be able to move
 * THROUGH a passage, not just between passages.
 *
 * Breaks on verse boundaries because a page ending mid-sentence and resuming on
 * the next is harder to read than a slightly short page.
 *
 * Returns [{ text, firstVerse, lastVerse }], or [] when nothing resolves.
 */
export async function buildPassagePages(ref, translation, budget = PASSAGE_PAGE_BUDGET) {
    try {
        const isChapterOnly = ref.startVerse == null;
        const from = isChapterOnly ? 1 : ref.startVerse;
        const to = isChapterOnly ? CHAPTER_VERSE_CEILING : (ref.endVerse ?? ref.startVerse);

        const rows = await bibleWrapper.getVerses(ref.bookId, ref.chapter, from, to);
        const verses = rows
            .map(r => ({ number: r.verse, text: r[translation] || r.BSB || r.KJV }))
            .filter(v => Boolean(v.text));
        if (verses.length === 0) return [];

        // One verse on its own needs no inline number — the heading already
        // names it. This matches verseTextFor so the reader and the card read
        // identically for the same passage.
        const numbered = verses.length > 1;
        const pages = [];
        let current = [];
        let used = 0;

        for (const v of verses) {
            const piece = numbered ? `**${v.number}** ${v.text}` : v.text;
            if (current.length > 0 && used + piece.length + 1 > budget) {
                pages.push(current);
                current = [];
                used = 0;
            }
            // A verse longer than the whole budget still gets its own page
            // rather than vanishing; no verse comes close, but dropping one
            // silently would be the worse failure.
            current.push({ number: v.number, piece });
            used += piece.length + 1;
        }
        if (current.length > 0) pages.push(current);

        return pages.map(p => ({
            text: p.map(v => v.piece).join(' '),
            firstVerse: p[0].number,
            lastVerse: p[p.length - 1].number,
        }));
    } catch (err) {
        logger.warn(`[Passive] Failed to page passage ${refLabel(ref)}: ${err.message}`);
        return [];
    }
}

/**
 * Render one page of the full-passage reader.
 *
 * Always ephemeral in practice, which is why it carries no ownership rules: the
 * only person who can see it is the one paging it, so there is nobody to
 * contend with and no need for the owner/private split the channel pager needs.
 */
export function buildPassageReaderComponents(ref, translation, pages, pageIndex) {
    const total = pages.length;
    const idx = Math.min(Math.max(pageIndex, 0), Math.max(0, total - 1));
    const page = pages[idx];

    const span = page.firstVerse === page.lastVerse
        ? `${ref.bookName} ${ref.chapter}:${page.firstVerse}`
        : `${ref.bookName} ${ref.chapter}:${page.firstVerse}-${page.lastVerse}`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## 📜 ${span} · ${translation}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(page.text))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(total > 1 ? `Page ${idx + 1} of ${total} · only you can see this` : 'Only you can see this')
        ));

    const components = [container];

    if (total > 1) {
        const base = passageCustomId(ref);
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${base}:${idx - 1}`)
                .setLabel('Back')
                .setEmoji({ name: '◀' })
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(idx <= 0),
            new ButtonBuilder()
                .setCustomId('passageread:noop')
                .setLabel(`${idx + 1} / ${total}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            new ButtonBuilder()
                .setCustomId(`${base}:${idx + 1}`)
                .setLabel('Next')
                .setEmoji({ name: '▶' })
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(idx >= total - 1),
        ));
    }

    return components;
}

// Pager modes, encoded as the third customId segment. The mode is baked in at
// RENDER time so the handler knows how to acknowledge — update in place versus
// open a private reply — without reading any guild config first. That matters:
// the ack must happen inside Discord's 3-second window, and a config read
// before acking is exactly the shape that produced "This interaction failed"
// during the 2026-07-19 outage.
//
//   u  public, shared    — anyone's click moves the post
//   o  public, owner-locked — the owner's click moves the post; everyone else
//                             gets their own private view. Carries the OWNER ID.
//   x  private view      — the clicker's own copy. Carries the ORIGIN message id,
//                          because a private message's own id is not the Redis
//                          key; the public post's is.
//
// Longest form is about 37 chars, well inside the 100-char customId cap.
export const PAGER_MODE_SHARED = 'u';
export const PAGER_MODE_OWNER = 'o';
export const PAGER_MODE_PRIVATE = 'x';

// Every control carries a REFERENCE index, never a page index. The public view
// shows one reference per page and the private view groups up to three, so a
// page number means different things in each — while "reference 6" means the
// same thing everywhere, which is what lets the jump menu and the arrows agree.
function pageCustomId(refIndex, mode, ctx) {
    return mode === PAGER_MODE_SHARED
        ? `passivepage:${refIndex}:${mode}`
        : `passivepage:${refIndex}:${mode}:${ctx}`;
}

function selectCustomId(mode, ctx) {
    return mode === PAGER_MODE_SHARED ? `passiveref:${mode}` : `passiveref:${mode}:${ctx}`;
}

// Prev / page-counter / next. The counter is a disabled button rather than a
// text line so the whole control reads as one unit, and the edge buttons are
// disabled rather than hidden so the row never changes width as you page.
//
// `back` and `next` are REFERENCE indices supplied by the caller: the public
// view steps one reference at a time, the private view jumps to the first
// reference of the adjacent group.
function buildPagerRow({ back, next, label, atStart, atEnd, mode, ctx }) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(pageCustomId(back, mode, ctx))
            .setLabel('Back')
            .setEmoji({ name: '◀' })
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(atStart),
        new ButtonBuilder()
            .setCustomId('passivepage:noop')
            .setLabel(label)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(pageCustomId(next, mode, ctx))
            .setLabel('Next')
            .setEmoji({ name: '▶' })
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(atEnd),
    );
}

// Jump menu listing every reference in the pager. Exists so reaching reference
// 19 costs one interaction rather than eighteen, which is most of what made a
// shared pager feel contended in the first place.
//
// Capped at 25 by Discord, which is why MAX_REFS_PAGINATED is also 25 — the
// menu can then always list everything, with no "and N more" caveat.
function buildRefSelectRow(refs, currentRefIndex, { mode, ctx }) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(selectCustomId(mode, ctx))
            .setPlaceholder('Jump to a reference')
            .addOptions(refs.map((ref, i) =>
                new StringSelectMenuOptionBuilder()
                    .setValue(String(i))
                    .setLabel(refLabel(ref))
                    .setDefault(i === currentRefIndex)
            ))
    );
}

// Note for references that didn't fit the pager at all. Deliberately a quiet
// footnote on the LAST page rather than an error: the user asked about verses
// and got verses, and the ones we dropped are still one command away.
function overflowNote(omitted) {
    return new TextDisplayBuilder().setContent(
        `-# ${omitted} more reference${omitted === 1 ? '' : 's'} in that message couldn't be shown here.`
        + ' Use `/bible` for any of them, or type the ones you want in a new message.'
    );
}

/**
 * Group references into private-view pages, ONCE, from reference 0 forward.
 *
 * Deterministic grouping is the whole point. Grouping greedily from whatever
 * reference the reader jumped to would give different boundaries depending on
 * where they entered, so Back followed by Next could land somewhere new — a
 * pager that doesn't return you where you were.
 *
 * Computed at post time and stored with the pager, so no click has to re-fetch
 * up to 25 references just to decide where the pages break.
 *
 * Returns an array of arrays of reference indices, e.g. [[0,1,2],[3],[4,5]].
 * A reference whose text alone exceeds the budget gets a page to itself.
 */
export async function computePageGroups(refs, translation) {
    const lengths = [];
    for (const ref of refs) {
        const text = await verseTextFor(ref, translation, PRIVATE_PAGE_BUDGET);
        lengths.push(text.length + PRIVATE_PAGE_REF_OVERHEAD);
    }

    const groups = [];
    let current = [];
    let used = 0;
    for (let i = 0; i < refs.length; i++) {
        const tooMany = current.length >= MAX_REFS_PER_PRIVATE_PAGE;
        const tooLong = current.length > 0 && used + lengths[i] > PRIVATE_PAGE_BUDGET;
        if (tooMany || tooLong) {
            groups.push(current);
            current = [];
            used = 0;
        }
        current.push(i);
        used += lengths[i];
    }
    if (current.length) groups.push(current);
    return groups;
}

function groupIndexFor(groups, refIndex) {
    const found = groups.findIndex(g => g.includes(refIndex));
    return found === -1 ? 0 : found;
}

/**
 * The PUBLIC post: one reference and the jump menu.
 *
 * NO arrow row. The menu reaches every reference the arrows could, and it does
 * so in one interaction instead of stepping — so a second control that can only
 * move by one is a row of chrome, not a capability. Position stays visible in
 * the container footer ("Reference 3 of 9"), which is where it already was.
 *
 * The PRIVATE view keeps its arrows: there they step by PAGE, covering several
 * references at a time, which the menu's per-reference jumps don't replicate.
 *
 * Exported because the pager controls re-render with it — the post path and the
 * paging path must produce identical layouts or the message would visibly
 * change shape the first time someone used it.
 */
export async function buildPaginatedComponents(refs, translation, index, { mode = PAGER_MODE_SHARED, ownerId = null, omitted = 0 } = {}) {
    const total = refs.length;
    // Clamp rather than trust: the index arrives from a customId, which a user
    // can replay from an older message after the list has been re-rendered.
    const safeIndex = Math.min(Math.max(index, 0), total - 1);
    const ref = refs[safeIndex];

    const { text: verseText, truncated } = await verseTextDetailed(ref, translation, PAGE_DISPLAY_TRUNCATE);
    const header = `## 📖 ${refLabel(ref)}${verseText ? ` · ${translation}` : ''}`;
    const body = verseText || '*(couldn\'t load the text for this reference — tap a button for study tools)*';

    // The omitted count rides in the FOOTER, on every page — not only on the
    // last one. A reader (the owner especially) opens on reference 1 and may
    // never walk to the end, so an end-of-list note is invisible to the person
    // most likely to care that their 30 references became 25.
    const footerParts = [];
    if (total > 1) footerParts.push(`Reference ${safeIndex + 1} of ${total}`);
    if (omitted > 0) footerParts.push(`${omitted} more not shown`);

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine(footerParts.length ? footerParts.join(' · ') : 'Tap a button for study tools')
        ));

    // The footer says HOW MANY are missing on every page; the last page also
    // says what to do about it, where someone who has read to the end is most
    // likely to want the answer.
    if (omitted > 0 && safeIndex === total - 1) {
        container.addTextDisplayComponents(overflowNote(omitted));
    }

    // A single reference has nowhere to jump to, so it gets no menu — a
    // one-option picker is a control that advertises a choice it doesn't have.
    if (total <= 1) return [container, buildOpenverseRow(ref, { truncated })];

    const ctx = mode === PAGER_MODE_OWNER ? ownerId : null;
    return [container, buildRefSelectRow(refs, safeIndex, { mode, ctx }), buildOpenverseRow(ref, { truncated })];
}

/**
 * The PRIVATE view: up to three references at once, each with its own study
 * buttons, plus arrows and the jump menu.
 *
 * This is the card layout with a pager bolted on — deliberately, since a page
 * holding several references needs per-reference study buttons, and a card with
 * its own button row directly beneath it is the pattern that already reads
 * correctly elsewhere in the bot.
 *
 * `index` is a REFERENCE index; the page containing it is what renders.
 */
export async function buildPrivatePageComponents(refs, translation, groups, index, { originId, omitted = 0 } = {}) {
    const total = refs.length;
    const safeIndex = Math.min(Math.max(index, 0), total - 1);
    const groupNo = groupIndexFor(groups, safeIndex);
    const group = groups[groupNo] ?? [safeIndex];

    // Budget guard: 1 container + 1 study row per reference, + pager + menu.
    // Trims rather than building a message Discord would reject outright.
    const maxRefs = Math.max(1, Math.floor((MAX_TOP_LEVEL_COMPONENTS - 2) / 2));
    const shown = group.slice(0, maxRefs);
    if (shown.length < group.length) {
        logger.warn(`[Passive] Private page trimmed ${group.length} refs to ${shown.length} for the component budget`);
    }

    const components = [];
    for (const refIndex of shown) {
        const ref = refs[refIndex];
        const { text: verseText, truncated } = await verseTextDetailed(ref, translation, PRIVATE_PAGE_BUDGET);
        const header = `## 📖 ${refLabel(ref)}${verseText ? ` · ${translation}` : ''}`;
        const body = verseText || '*(couldn\'t load the text for this reference — tap a button for study tools)*';

        components.push(new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine(`Reference ${refIndex + 1} of ${total}`)
            ))
        );
        components.push(buildOpenverseRow(ref, { truncated }));
    }

    const lastGroup = groupNo >= groups.length - 1;
    if (omitted > 0 && lastGroup) {
        components.push(new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(overflowNote(omitted))
        );
    }

    if (groups.length > 1) {
        const prevGroup = groups[groupNo - 1];
        const nextGroup = groups[groupNo + 1];
        components.push(buildPagerRow({
            back: prevGroup ? prevGroup[0] : 0,
            next: nextGroup ? nextGroup[0] : safeIndex,
            label: `${groupNo + 1} / ${groups.length}`,
            atStart: groupNo <= 0,
            atEnd: lastGroup,
            mode: PAGER_MODE_PRIVATE,
            ctx: originId,
        }));
    }
    components.push(buildRefSelectRow(refs, safeIndex, { mode: PAGER_MODE_PRIVATE, ctx: originId }));

    return components;
}

/**
 * Post a paginated verse browser as a reply to `anchorMessage`.
 *
 * Shared by the two things that surface verses: passive auto-post (anchored to
 * the user's message) and AI chat (anchored to Biblicana's own answer, whose
 * prose cites references rather than quoting them). Both go through here so a
 * pager looks and behaves identically wherever it came from.
 *
 * Pass `translation` to pin one explicitly; omit it to use the preference of
 * `userId`. Which applies depends on WHOSE citation is being expanded:
 *
 *   passive auto-post — the reference is the USER's, typed in their message, so
 *     it renders in the translation they chose with /setversion.
 *   AI chat — the reference is BIBLICANA's, cited in its own answer, so it
 *     renders in the house translation. A reader's personal preference should
 *     not silently rewrite what the bot is quoting, and nobody should have to
 *     change an account-wide setting to change what the bot posts.
 *
 * Returns the sent message, or null if there was nothing to post or no
 * permission to post it. Never throws into a caller's reply path.
 */
export async function postVersePager(anchorMessage, refs, database, { userId, translation: pinned, pagerPrivate } = {}) {
    if (!refs?.length) return null;

    const me = anchorMessage.guild?.members?.me;
    if (!me || !canSend(anchorMessage.channel, me)) return null;

    const translation = pinned ?? await userTranslation(database, userId ?? anchorMessage.author?.id);

    // Defaults TRUE when unreadable, matching readPassivePagerPrivate. Private
    // is the safer failure: a reader gets their own copy rather than moving a
    // post out from under the channel.
    let isPrivate = pagerPrivate;
    if (typeof isPrivate !== 'boolean') {
        try {
            const guildData = await database.getGuildValue(anchorMessage.guild.id);
            isPrivate = typeof guildData?.passivePagerPrivate === 'boolean' ? guildData.passivePagerPrivate : true;
        } catch {
            isPrivate = true;
        }
    }

    const paged = refs.slice(0, MAX_REFS_PAGINATED);
    const omitted = refs.length - paged.length;
    if (omitted > 0) {
        logger.info(`[Passive] Capped pager at ${MAX_REFS_PAGINATED} of ${refs.length} refs (anchor=${anchorMessage.id})`);
    }

    // The owner is whoever the references belong to: the person who typed them
    // for passive detection, the person who asked for AI chat. Under owner
    // paging their clicks move this post and everyone else gets a private copy.
    const ownerId = userId ?? anchorMessage.author?.id ?? null;
    const mode = (isPrivate && ownerId) ? PAGER_MODE_OWNER : PAGER_MODE_SHARED;

    const components = await buildPaginatedComponents(paged, translation, 0, { mode, ownerId, omitted });
    const sent = await anchorMessage.reply({
        flags: MessageFlags.IsComponentsV2,
        components,
        allowedMentions: { repliedUser: false },
    });

    // Written AFTER the post, keyed by the posted message's own id — that id
    // does not exist until the reply lands. Only for multi-ref posts: a single
    // reference has nothing to page to, and gets no controls at all.
    if (paged.length > 1) {
        // Page boundaries for the private view, computed ONCE here so no click
        // has to re-fetch every reference just to decide where pages break —
        // and so the boundaries are identical no matter which reference a
        // reader jumps in at. See computePageGroups.
        const groups = await computePageGroups(paged, translation);

        await database.setPassivePage(sent.id, {
            translation,
            omitted,
            groups,
            refs: paged.map(r => ({
                bookId: r.bookId,
                bookName: r.bookName,
                chapter: r.chapter,
                startVerse: r.startVerse ?? null,
                endVerse: r.endVerse ?? null,
            })),
        });
    }
    return sent;
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

// Biblicana's house translation. Used when nobody's preference applies — which
// includes every verse Biblicana cites in its OWN voice.
export const DEFAULT_TRANSLATION = 'BSB';

async function userTranslation(database, userId) {
    try {
        const pref = await database.getUserValue(userId);
        if (pref?.translation) return pref.translation;
    } catch { /* noop */ }
    return DEFAULT_TRANSLATION;
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
    // Layout is a per-guild admin choice. Read it here rather than threading it
    // down from messageCreate: autopost is the only mode that renders anything,
    // so this costs a cached read on the one path that can use it.
    let paginate = false;
    let detail = 'full';
    try {
        const guildData = await database.getGuildValue(message.guild.id);
        paginate = Boolean(guildData?.passivePaginate);
        if (guildData?.passiveDetail === 'compact') detail = 'compact';
    } catch (err) {
        // Fall back to the default layout rather than dropping the post.
        logger.debug(`[Passive] Could not read layout for ${message.guild.id}: ${err.message}`);
    }

    if (!paginate) {
        const translation = await userTranslation(database, message.author.id);
        const components = await buildAutopostComponents(refs, translation, detail);
        await message.reply({
            flags: MessageFlags.IsComponentsV2,
            components,
            allowedMentions: { repliedUser: false },
        });
        return;
    }

    await postVersePager(message, refs, database, { userId: message.author.id });
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
