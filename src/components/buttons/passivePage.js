import { PAGER_MODE_SHARED } from '../../utils/passiveDetection.js';
import { renderPagerInteraction } from '../../utils/pagerInteraction.js';
import logger from '../../utils/logger.js';

// Back / Next on a verse browser. customId:
//
//   passivepage:<refIndex>:u                 shared  — anyone's click moves the post
//   passivepage:<refIndex>:o:<ownerId>       owner   — owner moves the post,
//                                                      everyone else gets a private view
//   passivepage:<refIndex>:x:<originId>      private — moves the clicker's own copy
//   passivepage:<refIndex>                   legacy, treated as :u
//
// The index is a REFERENCE index, not a page number, because the public view
// shows one reference per page while the private view groups up to three. It is
// also the page to move TO, so nothing mutable is stored and two people clicking
// at once both land somewhere valid rather than racing a shared counter.
export default {
    id: 'passivepage',
    async execute(interaction, database) {
        // The page counter is disabled and cannot be clicked, but an old client
        // or a replayed interaction could still deliver it.
        if (interaction.customId === 'passivepage:noop') {
            return interaction.deferUpdate();
        }

        const [, indexStr, mode = PAGER_MODE_SHARED, ctx] = interaction.customId.split(':');
        const target = Number.parseInt(indexStr, 10);
        if (!Number.isInteger(target) || target < 0) {
            logger.warn(`[PassivePage] Malformed customId: ${interaction.customId}`);
            return interaction.deferUpdate();
        }

        return renderPagerInteraction(interaction, database, { mode, ctx, target });
    },
};
