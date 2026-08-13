import { MessageFlags, TextDisplayBuilder } from 'discord.js';
import {
    buildPaginatedComponents,
    buildPrivatePageComponents,
    computePageGroups,
    PAGER_MODE_OWNER,
    PAGER_MODE_PRIVATE,
} from './passiveDetection.js';
import logger from './logger.js';

const EXPIRED_NOTICE = 'This verse browser has expired — post the reference again for a fresh one.';

/**
 * Shared handling for every verse-pager control: the Back/Next buttons and the
 * jump menu. Both answer the same question — "show reference N" — and differ
 * only in where N comes from, so the routing, ownership check and rendering
 * live here rather than being written twice and drifting.
 *
 * @param {object} opts
 * @param {string} opts.mode    pager mode from the customId: u, o or x
 * @param {string} opts.ctx     owner id (mode o) or origin message id (mode x)
 * @param {number} opts.target  REFERENCE index to show
 */
export async function renderPagerInteraction(interaction, database, { mode, ctx, target }) {
    const isPrivateView = mode === PAGER_MODE_PRIVATE;

    // THE OWNERSHIP RULE, and the only place it is decided: under owner paging
    // the person the references belong to drives the public post, and everyone
    // else gets their own private copy of the same browser.
    const opensNewPrivate = mode === PAGER_MODE_OWNER && interaction.user.id !== ctx;

    // ACK FIRST, in the shape this path needs. Opening a private view sends a
    // NEW ephemeral message so it defers a reply; everything else edits an
    // existing message so it defers an update. This choice has to happen before
    // any I/O, which is exactly why the mode and owner ride in the customId
    // rather than being read from guild config here.
    if (opensNewPrivate) {
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } else {
        await interaction.deferUpdate();
    }

    // Where the reference list lives. A private view is a different message with
    // a different id, so it carries the origin; a control on the public post is
    // already sitting on the keyed message.
    const stateKey = isPrivateView ? ctx : interaction.message.id;
    const payload = await database.getPassivePage(stateKey);

    if (!payload?.refs?.length) {
        // Aged out, or Redis was unavailable when the pager was posted.
        if (opensNewPrivate) {
            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [new TextDisplayBuilder().setContent(EXPIRED_NOTICE)],
            });
        }
        // Ephemeral so an expired browser can't spam the channel.
        return interaction.followUp({ content: EXPIRED_NOTICE, flags: MessageFlags.Ephemeral });
    }

    const refs = payload.refs;
    const translation = payload.translation || 'BSB';
    const omitted = payload.omitted ?? 0;

    try {
        if (isPrivateView || opensNewPrivate) {
            // Boundaries are stored with the pager. Recomputing is a fallback
            // for records written before groups existed, not the normal path —
            // it costs a verse fetch per reference.
            const groups = payload.groups?.length
                ? payload.groups
                : await computePageGroups(refs, translation);

            const components = await buildPrivatePageComponents(refs, translation, groups, target, {
                originId: stateKey,
                omitted,
            });
            return await interaction.editReply({
                flags: opensNewPrivate
                    ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
                    : MessageFlags.IsComponentsV2,
                components,
            });
        }

        const components = await buildPaginatedComponents(refs, translation, target, {
            mode,
            ownerId: ctx,
            omitted,
        });
        return await interaction.editReply({
            flags: MessageFlags.IsComponentsV2,
            components,
        });
    } catch (err) {
        logger.error(`[PassivePage] Failed to render reference ${target} for ${stateKey}: ${err.message}`);
        return null;
    }
}
