import { MessageFlags } from 'discord.js';
import { PAGER_MODE_SHARED } from '../../utils/passiveDetection.js';
import { renderPagerInteraction } from '../../utils/pagerInteraction.js';
import logger from '../../utils/logger.js';

// The "Jump to a reference" menu on a verse browser. customId:
//
//   passiveref:u                 shared  — anyone's pick moves the post
//   passiveref:o:<ownerId>       owner   — owner's pick moves the post,
//                                          everyone else gets a private view
//   passiveref:x:<originId>      private — moves the clicker's own copy
//
// The selected value is a REFERENCE index, the same coordinate the Back/Next
// buttons use, which is what lets the two controls agree even though the public
// view shows one reference per page and the private view groups up to three.
//
// Deliberately the same ownership rule as the buttons: a control that moved the
// public post for one person and opened a private copy for another would be
// impossible to label honestly, so ALL controls follow one rule.
export default {
    id: 'passiveref',
    async execute(interaction, database) {
        const [, mode = PAGER_MODE_SHARED, ctx] = interaction.customId.split(':');
        const target = Number.parseInt(interaction.values?.[0], 10);

        if (!Number.isInteger(target) || target < 0) {
            logger.warn(`[PassiveRef] Malformed selection on ${interaction.customId}: ${interaction.values?.[0]}`);
            return interaction.reply({
                content: 'That reference is no longer available — post it again for a fresh browser.',
                flags: MessageFlags.Ephemeral,
            });
        }

        return renderPagerInteraction(interaction, database, { mode, ctx, target });
    },
};
