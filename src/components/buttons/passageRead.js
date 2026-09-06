import { MessageFlags } from 'discord.js';
import { buildPassagePages, buildPassageReaderComponents, DEFAULT_TRANSLATION } from '../../utils/passiveDetection.js';
import { coerceTranslation } from '../../utils/bibleHelper.js';
import { numbersToBook } from '../../utils/bookNames.js';
import logger from '../../utils/logger.js';

// The full-passage reader. customId:
//
//   passageread:<bookId>:<chapter>:<start>:<end>          open at page 1
//   passageread:<bookId>:<chapter>:<start>:<end>:<page>   move to <page>
//   passageread:noop                                     the disabled counter
//
// Verses 0/0 mean a chapter-only reference — page the whole chapter.
//
// ACK SHAPE IS DECIDED BY THE customId ALONE, with no I/O, which is why the
// page number is in the id rather than in stored state. Opening the reader
// creates a NEW ephemeral message (deferReply); paging edits the one already
// on screen (deferUpdate). Getting that wrong is not recoverable — Discord
// gives 3 seconds and the first ack fixes the shape for the rest of the
// interaction, so it cannot wait on a database read.
//
// The view is ephemeral, so it needs none of the owner/shared arbitration the
// channel pager carries: the only person who can see it is the one paging it.
export default {
    id: 'passageread',
    async execute(interaction, database) {
        if (interaction.customId === 'passageread:noop') {
            return interaction.deferUpdate();
        }

        const [, bookStr, chapterStr, startStr, endStr, pageStr] = interaction.customId.split(':');
        const bookId = Number.parseInt(bookStr, 10);
        const chapter = Number.parseInt(chapterStr, 10);
        const start = Number.parseInt(startStr, 10);
        const end = Number.parseInt(endStr, 10);
        const isPaging = pageStr !== undefined;
        const page = isPaging ? Number.parseInt(pageStr, 10) : 0;

        const bookName = numbersToBook.get(bookId);
        if (!Number.isInteger(bookId) || !Number.isInteger(chapter) || !bookName || !Number.isInteger(page)) {
            logger.warn(`[PassageRead] Malformed customId: ${interaction.customId}`);
            return isPaging
                ? interaction.deferUpdate()
                : interaction.reply({ content: 'That button is no longer valid.', flags: MessageFlags.Ephemeral });
        }

        // ACK FIRST — everything below is a SQLite read plus a Neon read for the
        // reader's translation.
        if (isPaging) {
            await interaction.deferUpdate();
        } else {
            await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
        }

        try {
            // 0 means the reference named a chapter, not a verse.
            const ref = {
                bookId,
                bookName,
                chapter,
                startVerse: start === 0 ? null : start,
                endVerse: end === 0 ? null : end,
            };

            // The reader's own preference: this is their private copy of a
            // passage they chose to open, not the bot quoting something.
            let translation = DEFAULT_TRANSLATION;
            try {
                const pref = await database.getUserValue(interaction.user.id);
                translation = coerceTranslation(pref?.translation);
            } catch (err) {
                logger.debug(`[PassageRead] Translation lookup failed: ${err.message}`);
            }

            const pages = await buildPassagePages(ref, translation);
            if (pages.length === 0) {
                return interaction.editReply({
                    flags: MessageFlags.IsComponentsV2,
                    components: buildPassageReaderComponents(
                        ref, translation,
                        [{ text: '*Could not load that passage. Try `/bible` for it.*', firstVerse: 1, lastVerse: 1 }],
                        0
                    ),
                });
            }

            logger.debug(`[PassageRead] ${bookName} ${chapter} page ${page + 1}/${pages.length} user=${interaction.user.id}`);
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPassageReaderComponents(ref, translation, pages, page),
            });
        } catch (err) {
            logger.error(`[PassageRead] Failed for ${interaction.customId}: ${err.message}`);
            // The defer already fixed the shape, so this must be an editReply.
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildPassageReaderComponents(
                    { bookId, bookName, chapter, startVerse: null, endVerse: null },
                    DEFAULT_TRANSLATION,
                    [{ text: '*Something went wrong reading that passage.*', firstVerse: 1, lastVerse: 1 }],
                    0
                ),
            }).catch(() => null);
        }
    },
};
