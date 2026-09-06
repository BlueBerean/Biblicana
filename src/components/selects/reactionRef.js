import { MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { buildExpansionReply } from '../../events/messageReactionAdd.js';
import { coerceTranslation } from '../../utils/bibleHelper.js';
import { numbersToBook } from '../../utils/bookNames.js';
import { accentColor } from '../../utils/theme.js';
import logger from '../../utils/logger.js';

// "Jump to a reference" on a book-emoji reaction card. customId is the static
// string "reactionref"; the chosen reference rides in the option VALUE as
// bookId:chapter:startVerse:endVerse, with 0 for a chapter-only reference.
//
// State lives entirely in the value, which is why this needs no Redis and no
// message-id lookup: a customId is capped at 100 characters and could not hold
// 25 references, but a select gives every option its own 100-char value. Two
// people using the menu at the same time therefore cannot race each other.
//
// The reply is EPHEMERAL. Anyone can add a reaction, so there is no owner to
// give control of the public card to, and moving it would pull the post out
// from under whoever else was reading it.
export default {
    id: 'reactionref',
    async execute(interaction, database) {
        const value = interaction.values?.[0] ?? '';
        const [bookStr, chapterStr, startStr, endStr] = value.split(':');
        const bookId = Number.parseInt(bookStr, 10);
        const chapter = Number.parseInt(chapterStr, 10);
        const start = Number.parseInt(startStr, 10);
        const end = Number.parseInt(endStr, 10);
        const bookName = numbersToBook.get(bookId);

        if (!Number.isInteger(bookId) || !Number.isInteger(chapter) || !bookName) {
            logger.warn(`[ReactionRef] Malformed value: ${value}`);
            return interaction.reply({
                content: 'That reference is no longer valid.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // ACK FIRST — the card below is several SQLite reads (verse text plus
        // commentator, Fathers and cross-reference counts) and a Neon read for
        // the translation, which together can outlast Discord's 3 seconds.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

        try {
            const ref = {
                bookId,
                bookName,
                chapter,
                startVerse: start === 0 ? null : start,
                endVerse: end === 0 ? null : end,
            };

            let translation = 'BSB';
            try {
                const pref = await database.getUserValue(interaction.user.id);
                translation = coerceTranslation(pref?.translation);
            } catch (err) {
                logger.debug(`[ReactionRef] Translation lookup failed: ${err.message}`);
            }

            // No siblings passed: the private copy needs no picker of its own,
            // since the public card it came from still has one.
            const reply = await buildExpansionReply(ref, translation);
            logger.debug(`[ReactionRef] ${bookName} ${chapter} user=${interaction.user.id}`);
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: reply.components,
            });
        } catch (err) {
            logger.error(`[ReactionRef] Failed for "${value}": ${err.message}`);
            // The defer already fixed the shape, so this must be an editReply
            // with V2 components - an empty array would be rejected outright.
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: [new ContainerBuilder()
                    .setAccentColor(accentColor())
                    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                        '*Could not load that reference. Try `/bible` for it.*'
                    ))],
            }).catch(() => null);
        }
    },
};
