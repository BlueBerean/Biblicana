import { MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { buildPassagePages, buildPassageReaderComponents } from '../../utils/passiveDetection.js';
import { lxxWrapper } from '../../utils/studyHelper.js';
import { numbersToBook } from '../../utils/bookNames.js';
import { accentColor } from '../../utils/theme.js';
import logger from '../../utils/logger.js';

// Full-passage reader for the Septuagint. customId:
//
//   lxxread:<bookId>:<chapter>:<start>:<end>          Masoretic-addressed book
//   lxxread:<CODE>:<chapter>:<start>:<end>            Septuagint-only book
//   lxxread:...:<page>                                move to <page>
//
// The first segment is NUMERIC for a book with a Masoretic address and a
// letter CODE (SIR, TOB, 1MA) for the deuterocanonical books, which have no
// Masoretic counterpart at all and so are looked up by their own name.
//
// Reuses buildPassagePages/buildPassageReaderComponents rather than carrying
// its own copy: /lxx reads a different corpus through a different wrapper, and
// a second paging loop here is precisely how this bot ended up with four verse
// renderers that each had to be fixed separately.
//
// ACK SHAPE IS DECIDED BY THE customId ALONE, with no I/O — opening creates a
// new ephemeral message, paging edits the one on screen.
export default {
    id: 'lxxread',
    async execute(interaction) {
        if (interaction.customId === 'lxxread:noop') {
            return interaction.deferUpdate();
        }

        const [, addr, chapterStr, startStr, endStr, pageStr] = interaction.customId.split(':');
        const chapter = Number.parseInt(chapterStr, 10);
        const start = Number.parseInt(startStr, 10);
        const end = Number.parseInt(endStr, 10);
        const isPaging = pageStr !== undefined;
        const page = isPaging ? Number.parseInt(pageStr, 10) : 0;

        // A numeric address is a Masoretic book id; anything else is a
        // Septuagint-only book code.
        const bookId = /^\d+$/.test(addr ?? '') ? Number.parseInt(addr, 10) : null;
        const code = bookId === null ? addr : null;
        const bookName = bookId !== null ? numbersToBook.get(bookId) : code;

        if (!Number.isInteger(chapter) || !bookName || !Number.isInteger(page)) {
            logger.warn(`[LxxRead] Malformed customId: ${interaction.customId}`);
            return isPaging
                ? interaction.deferUpdate()
                : interaction.reply({ content: 'That button is no longer valid.', flags: MessageFlags.Ephemeral });
        }

        if (isPaging) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        }

        try {
            const ref = {
                bookId,
                bookName,
                chapter,
                startVerse: start === 0 ? null : start,
                endVerse: end === 0 ? null : end,
            };

            // The Septuagint wrapper has no translation columns — Brenton is the
            // only rendering — so the fetcher just normalises its rows.
            const fetchVerses = async (r, from, to) => {
                const rows = bookId !== null
                    ? await lxxWrapper.getVerses(bookId, r.chapter, from, to)
                    : await lxxWrapper.getByCode(code, r.chapter, from, to);
                return rows
                    .map(x => ({ number: x.verse, text: x.text }))
                    .filter(v => Boolean(v.text));
            };

            const pages = await buildPassagePages(ref, 'LXX', undefined, fetchVerses);
            if (pages.length === 0) {
                return this.fail(interaction, `No Septuagint text for **${bookName} ${chapter}**.`);
            }

            const base = `lxxread:${addr}:${chapter}:${start}:${end}`;
            logger.debug(`[LxxRead] ${bookName} ${chapter} page ${page + 1}/${pages.length} user=${interaction.user.id}`);
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPassageReaderComponents(ref, 'LXX', pages, page, {
                    customIdBase: base,
                    heading: 'Brenton\'s Septuagint',
                }),
            });
        } catch (err) {
            logger.error(`[LxxRead] Failed for ${interaction.customId}: ${err.message}`);
            return this.fail(interaction, 'Something went wrong reading the Septuagint.');
        }
    },

    // The defer already fixed the shape, so this must be an editReply with V2
    // components — an empty array would be rejected outright.
    fail(interaction, message) {
        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [new ContainerBuilder()
                .setAccentColor(accentColor())
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(message))],
        }).catch(() => null);
    },
};
