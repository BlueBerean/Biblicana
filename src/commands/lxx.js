import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType,
} from 'discord.js';
import { bibleWrapper, coerceTranslation } from '../utils/bibleHelper.js';
import { getBookId, numbersToBook } from '../utils/bookNames.js';
import { resolveSingleChapterRef } from '../utils/scriptureRefs.js';
import { lxxWrapper } from '../utils/studyHelper.js';
import { accentColor, footerLine } from '../utils/theme.js';
import logger from '../utils/logger.js';
import 'dotenv/config';

// Discord's plain V2 TextDisplay ceiling is 4000; leave room for headings,
// the Hebrew-side text and the footer.
const MAX_LXX_CHARS = 1800;
const MAX_HEBREW_CHARS = 900;
const MAX_VERSES = 20;

// The card is a summary; the reader behind Read full is where a long passage
// actually gets read. MAX_VERSES bounds only what the CARD fetches - 765
// chapters exceed 20 verses, so on its own that cap meant /lxx Psalms 119
// could never show more than a fifth of the psalm and offered no way onward.
//
// Chapter-only and range references carry 0 for the verses they do not name,
// which tells the reader to page the whole thing rather than the card's slice.
function lxxReadCustomId(addr, chapter, startVerse, endVerse) {
    return `lxxread:${addr}:${chapter}:${startVerse ?? 0}:${endVerse ?? 0}`;
}

function readFullRow(addr, chapter, startVerse, endVerse) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(lxxReadCustomId(addr, chapter, startVerse, endVerse))
            .setLabel('Read full')
            .setEmoji({ name: '📜' })
            .setStyle(ButtonStyle.Primary)
    );
}

/**
 * /lxx — how the Septuagint renders a passage, in Brenton's English (1851).
 *
 * Answers a question the rest of the bot cannot: the Greek translators read the
 * Hebrew centuries before the Masoretic vowels were fixed, and where they
 * differ the difference is often the point (Isaiah 7:14's "virgin", the wording
 * the New Testament authors quote). So the card shows BOTH renderings rather
 * than replacing one with the other.
 *
 * The Septuagint's own chapter and verse numbers differ from the Hebrew, and
 * the card always prints them. A reader who knows the LXX expects to see
 * "Psalm 50:12" next to Psalm 51:10; hiding it would make the card look wrong.
 */
export default {
    data: new SlashCommandBuilder()
        .setName('lxx')
        .setDescription('See how the Septuagint (Greek Old Testament) renders a passage, in English')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel)
        .addStringOption(option =>
            option.setName('book')
                .setDescription('Book of the Old Testament, or a Septuagint book like Sirach or Tobit')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('chapter')
                .setDescription('The chapter number')
                .setRequired(true))
        .addNumberOption(option =>
            option.setName('verse')
                .setDescription('Starting verse (omit for the whole chapter opening)')
                .setMinValue(1))
        .addNumberOption(option =>
            option.setName('endverse')
                .setDescription('Ending verse, for a range')
                .setMinValue(1)),

    async execute(interaction, database) {
        // ACK FIRST — see configDailyEnabled.js for the rationale. Everything
        // below is SQLite plus a Neon read for the user's translation.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });

        const bookInput = interaction.options.getString('book');
        const chapterInput = interaction.options.getString('chapter');
        let startVerse = interaction.options.getNumber('verse');
        let endVerseInput = interaction.options.getNumber('endverse');

        let chapter = Number.parseInt(String(chapterInput).trim(), 10);
        if (!Number.isInteger(chapter) || chapter < 1) {
            return this.fail(interaction, `**${chapterInput}** isn't a chapter number I can use.`);
        }

        try {
            const bookId = getBookId(bookInput, { silent: true });

            // A Septuagint-only book (Sirach, Tobit, 1 Maccabees). These have no
            // Masoretic address at all, so they are looked up by their own name
            // and shown without a Hebrew column.
            if (!bookId) {
                const deutero = await lxxWrapper.resolveDeuteroBook(bookInput);
                if (!deutero) {
                    const books = await lxxWrapper.listDeuteroBooks();
                    return this.fail(interaction,
                        `I don't recognise **${bookInput}** as an Old Testament or Septuagint book.\n\n`
                        + `-# Septuagint-only books: ${books.map(b => b.name).join(', ')}.`);
                }
                return this.renderDeutero(interaction, deutero, chapter, startVerse, endVerseInput);
            }

            const bookName = numbersToBook.get(bookId);

            // The Septuagint is the Greek OLD Testament; there is no LXX of the
            // New. Say so plainly rather than returning an empty card.
            if (bookId > 39) {
                return this.fail(interaction,
                    `**${bookName}** is in the New Testament. The Septuagint is the Greek translation of the *Old* Testament, so there's no LXX reading for it.\n\n`
                    + '-# For the Greek of a New Testament verse, use `/originaltext` or `/interlinear`.');
            }

            // "book:Obadiah chapter:15" means Obadiah 1:15 - Obadiah has one
            // chapter. Applied here rather than above so the Septuagint-only
            // books, which have their own numbering, are left untouched.
            ({ chapter, startVerse, endVerse: endVerseInput } = resolveSingleChapterRef(bookId, chapter, startVerse, endVerseInput));

            const from = startVerse ?? 1;
            const to = Math.min(endVerseInput ?? (startVerse ? startVerse : 6), from + MAX_VERSES - 1);

            // Whether MAX_VERSES clipped the request, decided BEFORE the
            // clamp so the button can offer what the card could not show.
            const requestedTo = endVerseInput ?? (startVerse ? startVerse : null);
            const capped = requestedTo === null || requestedTo > to;

            const rows = await lxxWrapper.getVerses(bookId, chapter, from, to);
            if (rows.length === 0) {
                return this.fail(interaction,
                    `I don't have a Septuagint reading for **${bookName} ${chapter}:${from}**.\n\n`
                    + '-# The Greek does not always have a verse where the Hebrew does — some headings and oracles have no counterpart at all. Try a nearby verse, or the chapter opening.');
            }

            // The Hebrew-side rendering, for comparison. Best-effort: the card
            // is still worth showing if this fails.
            let hebrew = '';
            let translation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                translation = coerceTranslation(userPref?.translation);
                const mt = await bibleWrapper.getVerses(bookId, chapter, from, to);
                hebrew = mt.map(r => r[translation] || r.BSB || r.KJV).filter(Boolean).join(' ');
            } catch (err) {
                logger.debug(`[LXX Command] Hebrew-side fetch failed for ${bookName} ${chapter}: ${err.message}`);
            }

            const label = to > from ? `${bookName} ${chapter}:${from}-${to}` : `${bookName} ${chapter}:${from}`;
            const lxxRefs = rows.map(r => r.lxx_ref);
            const lxxLabel = lxxRefs.length > 1
                ? `${lxxRefs[0]} - ${lxxRefs[lxxRefs.length - 1].split(' ').pop()}`
                : lxxRefs[0];

            const body = rows.length > 1
                ? rows.map(r => `**${r.verse}** ${r.text}`).join(' ')
                : rows[0].text;

            const container = new ContainerBuilder()
                .setAccentColor(accentColor())
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `## 📜 ${label} · Septuagint`
                ))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `**${lxxLabel}** — Brenton's English (1851)\n${truncate(body, MAX_LXX_CHARS)}`
                ));

            if (hebrew) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    `### From the Hebrew · ${translation}\n${truncate(hebrew, MAX_HEBREW_CHARS)}`
                ));
            }

            if (rows.some(r => r.approx)) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    '-# ⚠️ The Septuagint arranges this chapter differently from the Hebrew, so the verse numbers may not line up exactly. Read the Greek reference above as the authority for what is quoted.'
                ));
            }

            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine('Brenton\'s Septuagint (1851, public domain)')
            ));

            // Offer the reader when the card is not showing the whole thing -
            // either the text was cut or MAX_VERSES clipped the range.
            const components = [container];
            if (capped || body.length > MAX_LXX_CHARS) {
                components.push(readFullRow(bookId, chapter, startVerse, endVerseInput));
            }

            return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components });
        } catch (err) {
            logger.error(`[LXX Command] Failed for "${bookInput} ${chapterInput}": ${err.message}`);
            return this.fail(interaction, 'Something went wrong reading the Septuagint. Try again in a moment.');
        }
    },

    async renderDeutero(interaction, book, chapter, startVerse, endVerse) {
        const from = startVerse ?? 1;
        const to = Math.min(endVerse ?? (startVerse ? startVerse : 6), from + MAX_VERSES - 1);
        const requestedTo = endVerse ?? (startVerse ? startVerse : null);
        const capped = requestedTo === null || requestedTo > to;
        const rows = await lxxWrapper.getByCode(book.code, chapter, from, to);

        if (rows.length === 0) {
            return this.fail(interaction, `I don't have **${book.name} ${chapter}:${from}**.`);
        }

        const body = rows.length > 1
            ? rows.map(r => `**${r.verse}** ${r.text}`).join(' ')
            : rows[0].text;

        const container = new ContainerBuilder()
            .setAccentColor(accentColor())
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `## 📜 ${book.name} ${chapter}:${from}${to > from ? `-${to}` : ''} · Septuagint`
            ))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(body, MAX_LXX_CHARS)))
            // Stated once, plainly, without arguing a position: this book is in
            // the Septuagint and is not in the Protestant Old Testament. Both
            // halves are facts, and a reader deserves to know which they hold.
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                `-# ${book.name} is part of the Septuagint but is not in the Protestant Old Testament, so it has no chapter-and-verse counterpart in Biblicana's other commands.`
            ))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                footerLine('Brenton\'s Septuagint (1851, public domain)')
            ));

        const components = [container];
        if (capped || body.length > MAX_LXX_CHARS) {
            components.push(readFullRow(book.code, chapter, startVerse, endVerse));
        }

        return interaction.editReply({ flags: MessageFlags.IsComponentsV2, components });
    },

    fail(interaction, message) {
        // V2 components, not `content` — the defer above locked the shape.
        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [new ContainerBuilder()
                .setAccentColor(accentColor())
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(message))],
        });
    },
};

function truncate(text, limit) {
    const s = String(text ?? '');
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
}
