import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import logger from './logger.js';

const DEFAULT_TIMEOUT_MS = 600_000;

// Discord API error codes meaning "the thing we're editing is already gone":
//   10008 — Unknown Message (the message was deleted)
//   10062 — Unknown interaction
//   50027 — Invalid Webhook Token (the interaction webhook token expired; fires
//           when a collector outlives the 15-min interaction-token window, e.g.
//           the 30-min /commentary and /fathers collectors hitting their end
//           handler well after the token died)
// All three are expected at end-of-life — disabling buttons on a dead token is
// a no-op we don't need, so they must never be logged as errors.
const EXPIRED_INTERACTION_CODES = new Set([10008, 10062, 50027]);
export function isExpiredInteractionError(err) {
    return EXPIRED_INTERACTION_CODES.has(err?.code);
}

/**
 * Send an interaction response whether or not the caller already deferred.
 *
 * Renderers are shared between handlers that defer first (so the ack beats
 * Discord's 3-second window) and older call sites that reply directly.
 * Hard-coding `interaction.reply()` inside a renderer is what made the slow
 * handlers unfixable: the RENDERER owned the ack, so no caller could ack
 * earlier without causing 40060 "already acknowledged". This inverts that —
 * the caller owns the ack, the renderer just supplies content.
 *
 * IMPORTANT: the response SHAPE is locked at defer time and the shapes are
 * mutually exclusive. A caller that defers with IsComponentsV2 must receive
 * `components` here, never `content`, and ephemerality cannot be changed after
 * the fact — defer with the same flags the renderer will ultimately use.
 */
export async function respondToInteraction(interaction, payload) {
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload);
    }
    return interaction.reply(payload);
}

export function buildPageNavRow({ pageIdx, totalPages, disabled = false }) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('page_back')
            .setEmoji({ name: '◀️' })
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || pageIdx === 0),
        new ButtonBuilder()
            .setCustomId('page_next')
            .setEmoji({ name: '▶️' })
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || pageIdx === totalPages - 1)
    );
}

// Attaches a page_back/page_next collector to a Discord message. `render` is a
// pure function of (pageIdx, { disableNav }) → components[] — it owns page
// state shape, the helper owns collector lifecycle, pageIdx math, and the
// interaction-gone error codes (10008/10062) that fire when the user
// dismisses the message before the collector times out.
//
// Returns the collector so callers can stop() it early or attach additional
// handlers. Swallows the end-of-life race silently, as it's always expected.
export function attachPageCollector({
    interaction,
    message,
    totalPages,
    render,
    logLabel,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    let pageIdx = 0;
    const flags = MessageFlags.IsComponentsV2;
    const filter = i => i.user.id === interaction.user.id &&
        (i.customId === 'page_back' || i.customId === 'page_next');
    const collector = message.createMessageComponentCollector({ filter, time: timeoutMs });

    collector.on('collect', async i => {
        try {
            await i.deferUpdate();
            if (i.customId === 'page_back') pageIdx = Math.max(0, pageIdx - 1);
            else if (i.customId === 'page_next') pageIdx = Math.min(totalPages - 1, pageIdx + 1);
            await i.editReply({ flags, components: render(pageIdx, { disableNav: false }) });
        } catch (err) {
            logger.error(`${logLabel} Pagination error: ${err.message}`);
        }
    });

    collector.on('end', async () => {
        try {
            await interaction.editReply({
                flags,
                components: render(pageIdx, { disableNav: true })
            });
        } catch (err) {
            if (!isExpiredInteractionError(err)) {
                logger.error(`${logLabel} End error: ${err.message}`);
            }
        }
    });

    return collector;
}
