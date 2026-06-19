import { MessageFlags } from 'discord.js';
import { markAiTermsAcked, buildAckConfirmedV2 } from '../../utils/aiAck.js';
import { handleAiChat } from '../../utils/aiChat.js';
import logger from '../../utils/logger.js';

// Handler for the first-use Terms acknowledgment button. Used by two origins:
//
//   A) AI chat: handleAiChat posts the disclosure as a plain-text reply to
//      the user's message. On ack click we edit to a plain "acknowledged"
//      message AND re-process the original user message (skipAckGate:true)
//      so they don't have to retype. Zero extra user action.
//
//   B) Slash commands (/find, /web): the command editReply's the deferred
//      interaction with a Components V2 disclosure. We can't cleanly re-run
//      a slash command from a button interaction (options shape differs,
//      interaction tokens differ), so on ack click we edit to a V2
//      "acknowledged" message that asks the user to re-run their command.
//      One extra user action, acceptable since it's one-time-per-user-ever.
//
// Distinguishing the two origins: the V2 flag on interaction.message. AI
// chat disclosures are plain messages (no V2 flag); slash-command
// disclosures are V2-wrapped. message.reference.messageId would also work
// (AI chat disclosure is a reply to a user message; slash-command reply
// has no reference), but the V2 flag is a more direct signal about which
// render format the message currently uses.
//
// customId format: `aichat_ack:<userId>`
export default {
    id: 'aichat_ack',
    async execute(interaction, database) {
        const [, encodedUserId] = interaction.customId.split(':');

        if (encodedUserId && interaction.user.id !== encodedUserId) {
            await interaction.reply({
                content: 'This acknowledgment notice is for a different user. Your own will appear the first time you use a feature that needs one.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const saved = await markAiTermsAcked(database, interaction.user.id);
        if (!saved) {
            // DB failed — don't strip the button, tell the user to retry.
            // Fail-closed: we never set the flag, so next attempt still gates.
            await interaction.reply({
                content: 'Couldn\'t save your acknowledgment right now — please try again in a moment.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const isV2 = interaction.message?.flags?.has(MessageFlags.IsComponentsV2) ?? false;

        try {
            if (isV2) {
                // Slash-command origin — V2 container with "run again" copy.
                await interaction.update({ components: buildAckConfirmedV2() });
            } else {
                // AI chat origin — plain text acknowledged message.
                await interaction.update({
                    content: '**✓ Acknowledged.** You\'re all set — continue the conversation anytime. Use `/forget` to erase your memory, or `/support` for questions.',
                    components: [],
                });
            }
        } catch (err) {
            logger.warn(`[AiAck] Could not edit disclosure on ack: ${err.message}`);
        }

        // AI chat re-processing: only applies when the disclosure was a reply
        // to a user message (AI chat path). Slash-command disclosures have
        // no referenced user message; we've already told the user to re-run.
        const originalId = interaction.message?.reference?.messageId;
        if (!originalId || isV2) return;
        try {
            const original = await interaction.channel.messages.fetch(originalId);
            await handleAiChat(original, database, { skipAckGate: true });
        } catch (err) {
            // Common here if the original was deleted or too old to fetch;
            // the user already has the acknowledged state, so a fresh
            // message from them will flow normally.
            logger.debug(`[AiAck] Original message not re-processable: ${err.message}`);
        }
    },
};
