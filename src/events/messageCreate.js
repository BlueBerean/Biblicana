import { Events, MessageFlags } from 'discord.js';
import logger from '../utils/logger.js';
import { handleMessageForPassiveDetection } from '../utils/passiveDetection.js';
import { handleAiChat } from '../utils/aiChat.js';
import { readAiEnabled, readAiChannels, isAiChannelAllowed, readAiDeniedRoles, isAiDeniedForMember } from '../utils/aiConfig.js';

// Decide whether this message should trigger AI chat, weighing reply-context
// and @mention signals correctly.
//
// Key nuance: when a user hits Discord's reply button, Discord auto-injects
// a mention of the replied-to user. That means a reply to Biblicana's V2
// card looks like "@Biblicana" from the bot's perspective, which would
// falsely fire AI if we checked mention first. The reply signal is stronger
// than the mention signal and must be checked first.
//
// Reply rules:
//   - Reply to a Biblicana CHAT message (plain content) → AI fires
//   - Reply to a Biblicana V2 message (tool output / card) → SILENT
//     (override the auto-injected mention — the user is commenting on the
//     card, not asking the AI)
//   - Reply to someone else (user / other bot) → fall through to mention
//
// No-reply rules:
//   - @mention → AI fires
//   - Nothing → silent (falls through to passive detection)
async function shouldAiFire({ message, botId, isDM, isMention }) {
    if (isDM) return true;

    const refId = message.reference?.messageId;
    if (refId) {
        try {
            const referenced = await message.channel.messages.fetch(refId);
            if (referenced.author?.id === botId) {
                // Reply target is our bot. Reply-rules override mention.
                if (referenced.flags?.has(MessageFlags.IsComponentsV2)) {
                    return false;   // V2 card = silent, always
                }
                return true;        // plain chat = continue conversation
            }
            // Reply to someone else — mention rules apply.
            return isMention;
        } catch {
            // Couldn't resolve the reply target; fall back to mention.
            return isMention;
        }
    }

    return isMention;
}

export default {
    name: Events.MessageCreate,
    async execute(message, database) {
        // Outer guard: this is the only gateway listener without a top-level
        // catch. It runs on every message in 512 servers; one unhandled throw
        // here would otherwise surface as an unhandledRejection.
        try {
            if (message.author.bot) return;
            if (!message.content || message.content.length < 2) return;

            const botId = message.client.user?.id;
            const isDM = !message.guild;
            const isMention = botId ? message.mentions.users.has(botId) : false;

            // Resolve AI eligibility with the CHEAP gate before the expensive
            // one. shouldAiFire does a Discord REST reply-fetch on every reply;
            // running it in an AI-disabled guild would burn REST quota on a
            // feature that can't fire there. So in a guild, only consult
            // shouldAiFire once the cached per-guild AI flag says AI is on (and
            // only when the message could even be AI: a mention or a reply).
            //
            // NOTE: the isDM branch is currently DEAD — the DirectMessages intent
            // is commented out in index.js because Discord won't deliver DMs to
            // the bot (see FOLLOWUPS.md "DM AI chat"). Kept so re-enabling is just
            // uncommenting the intent. With the intent off, isDM is never true.
            let aiEligible = isDM;
            if (!isDM && botId) {
                const couldBeAi = isMention || Boolean(message.reference?.messageId);
                if (couldBeAi && await readAiEnabled(database, message.guild.id)) {
                    // AI is on for the guild. Honor the per-channel allowlist:
                    // empty list = all channels; otherwise this channel (or its
                    // thread parent) must be listed. Only gates the conversation —
                    // slash commands are unaffected.
                    const allowedChannels = await readAiChannels(database, message.guild.id);
                    aiEligible = isAiChannelAllowed(allowedChannels, message.channel);

                    // Role denylist: a server can hand out a "No AI" role and
                    // members holding it get no response. Checked only after the
                    // channel gate passes, so the common case (no denylist
                    // configured) costs one cached read and nothing more.
                    if (aiEligible) {
                        const deniedRoles = await readAiDeniedRoles(database, message.guild.id);
                        if (isAiDeniedForMember(deniedRoles, message.member)) {
                            // Silent, deliberately. A "you are blocked" reply
                            // would be noisier than the feature it enforces and
                            // invites argument in-channel; the admin who set the
                            // role is the right person to explain it.
                            logger.debug(`[AiChat] Suppressed for denied role — user=${message.author.id} guild=${message.guild.id}`);
                            aiEligible = false;
                        }
                    }
                }
            }

            const aiTriggered = (aiEligible && botId)
                ? await shouldAiFire({ message, botId, isDM, isMention })
                : false;

            if (aiTriggered) {
                await handleAiChat(message, database);
                return;
            }

            // Passive scripture detection — guild-only. Respects per-guild mode.
            if (!message.guild) return;
            let mode = 'silent';
            try {
                const guildData = await database.getGuildValue(message.guild.id);
                if (guildData?.passiveMode) mode = guildData.passiveMode;
            } catch (err) {
                logger.debug(`[Passive] Failed to read guild config for ${message.guild.id}: ${err.message}`);
                return;
            }
            if (mode === 'silent') return;

            await handleMessageForPassiveDetection(message, mode, database);
        } catch (err) {
            logger.error(`[MessageCreate] Unhandled: ${err.message}`);
        }
    },
};
