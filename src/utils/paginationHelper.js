import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import logger from './logger.js';

const DEFAULT_TIMEOUT_MS = 600_000;

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
            if (err.code !== 10008 && err.code !== 10062) {
                logger.error(`${logLabel} End error: ${err.message}`);
            }
        }
    });

    return collector;
}
