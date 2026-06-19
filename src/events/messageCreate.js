import { Events, MessageFlags } from 'discord.js';
import logger from '../utils/logger.js';
import { handleMessageForPassiveDetection } from '../utils/passiveDetection.js';
import { handleAiChat } from '../utils/aiChat.js';
import { readAiEnabled } from '../utils/aiConfig.js';

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
        if (message.author.bot) return;
        if (!message.content || message.content.length < 2) return;

        const botId = message.client.user?.id;
        const isDM = !message.guild;
        const isMention = botId ? message.mentions.users.has(botId) : false;

        // AI dispatch path — triggered by explicit address:
        //   - @mention in a guild channel, or
        //   - reply (Discord's reply button) to any bot message, or
        //   - any DM (DMs always mean "talking to the bot")
        const aiTriggered = botId
            ? await shouldAiFire({ message, botId, isDM, isMention })
            : false;

        if (aiTriggered) {
            // Per-guild opt-in. DMs bypass the gate — a user DMing the bot
            // has explicitly chosen to talk to it, no server admin consent
            // relevant there.
            if (!isDM) {
                const enabled = await readAiEnabled(database, message.guild.id);
                if (!enabled) return;  // mentioned in a server that hasn't opted in — silent
            }
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
    },
};
