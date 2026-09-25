import { Events, MessageFlags } from 'discord.js';
import * as Sentry from '@sentry/node';
import logger from '../utils/logger.js';
import { reportError, componentName, withReportingScope } from '../utils/errorReporting.js';

const MAX_OPT_VALUE_LEN = 60;

// Flatten slash-command option data into a single compact string for logs.
// Handles subcommands (which nest their args under .options) so subcommand
// trees like `/foo sub:bar arg:baz` still show up as `sub=bar;arg=baz`.
function summarizeOptions(data) {
    if (!Array.isArray(data) || data.length === 0) return '';
    const parts = [];
    for (const opt of data) {
        if (opt.options && Array.isArray(opt.options)) {
            parts.push(`${opt.name}=${opt.value ?? ''}`);
            parts.push(summarizeOptions(opt.options));
        } else if (opt.value !== undefined) {
            const v = String(opt.value);
            const truncated = v.length > MAX_OPT_VALUE_LEN
                ? v.substring(0, MAX_OPT_VALUE_LEN - 1) + '…'
                : v;
            parts.push(`${opt.name}=${truncated}`);
        }
    }
    return parts.filter(Boolean).join(';');
}

export default {
    name: Events.InteractionCreate,
    async execute(interaction, database) {
        if (interaction.isCommand()) {
            const command = interaction.client.commands.get(interaction.commandName);

            if (!command) {
                if (interaction.replied) return;
                return interaction.reply(`No command matching ${interaction.commandName} was found.`);
            }

            // One-line usage log. Grep `[Usage] cmd=<name>` from PM2 logs to
            // count invocations per command / per user / per guild without
            // each command needing its own logging.
            const opts = summarizeOptions(interaction.options?.data);
            logger.info(
                `[Usage] cmd=${interaction.commandName} user=${interaction.user.id} guild=${interaction.guildId ?? 'DM'}${opts ? ` opts=${opts}` : ''}`
            );

            try {
                // One root span per command: there is no inbound HTTP request
                // for Sentry to start a trace from, so without this the pg,
                // ioredis and outbound-HTTP spans would have no parent and no
                // name saying which command they belonged to.
                //
                // withReportingScope tags everything the command does with its
                // guild/area/handler, so a reportError() inside the command's own
                // catch blocks is attributable without being handed `interaction`.
                await withReportingScope(
                    { area: 'command', handler: interaction.commandName, guildId: interaction.guildId },
                    () => Sentry.startSpan(
                        { name: `/${interaction.commandName}`, op: 'discord.command' },
                        () => command.execute(interaction, database)
                    )
                );
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.commandName}`);
                logger.error(error);
                reportError(error, { area: 'command', handler: interaction.commandName, guildId: interaction.guildId });

                if (error.code === 10062) {
                    logger.error('[Error] Interaction timed out');
                    return;
                }

                try {
                    const errorResponse = {
                        content: 'There was an error executing this command!',
                        flags: MessageFlags.Ephemeral
                    };

                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply(errorResponse);
                    } else if (interaction.deferred) {
                        await interaction.editReply(errorResponse);
                    }
                } catch (e) {
                    if (e.code !== 10062) {
                        logger.error('[Error] Could not send error message to user');
                        logger.error(e);
                    }
                }
            }
        } else if (interaction.isButton()) {
            let button = interaction.client.buttons.get(interaction.customId);
            // Parametric custom IDs (e.g., "strongs:Greek:G2316") fall back to prefix lookup.
            // Handlers receive the full customId and parse their own arguments.
            if (!button && interaction.customId.includes(':')) {
                button = interaction.client.buttons.get(interaction.customId.split(':')[0]);
            }

            if (!button) {
                // No registered handler. Most unknown customIds are managed
                // by inline collectors (e.g., /commentary's cmtr_select,
                // /fathers' fathers_next, pagination's page_next). Replying
                // "no button found" here races the collector's deferUpdate
                // and throws 40060 "already acknowledged." Silent return is
                // correct — the collector handles the event if it's theirs;
                // genuinely orphaned customIds would only come from a
                // developer typo, which shows up in dev testing anyway.
                return;
            }

            // Button usage log. Chain interactions ([Open] → /bible, [Commentary],
            // etc.) matter for understanding UX flow, so they go in the same
            // [Usage] stream as slash commands.
            logger.info(
                `[Usage] btn=${interaction.customId} user=${interaction.user.id} guild=${interaction.guildId ?? 'DM'}`
            );

            const buttonName = componentName(interaction.customId);
            try {
                await withReportingScope(
                    { area: 'button', handler: buttonName, guildId: interaction.guildId },
                    () => Sentry.startSpan(
                        { name: `button ${buttonName}`, op: 'discord.button' },
                        () => button.execute(interaction, database)
                    )
                );
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.customId}`);
                logger.error(error);
                reportError(error, { area: 'button', handler: buttonName, guildId: interaction.guildId });
            }
        } else if (interaction.isAnySelectMenu()) {
            // Covers StringSelect, ChannelSelect, UserSelect, RoleSelect, and
            // MentionableSelect — all dispatch through the same `selects`
            // registry. Mirror the button dispatch: exact match first, then
            // colon-prefix lookup so parametric custom IDs like "welcome:passive"
            // or "config:daily:channel" work. Inline-collector-based select
            // menus (e.g., commentary.js) don't register here — they handle
            // their own events within the command.
            let select = interaction.client.selects.get(interaction.customId);
            if (!select && interaction.customId.includes(':')) {
                select = interaction.client.selects.get(interaction.customId.split(':')[0]);
            }
            if (!select) return;  // Likely an inline-handled collector; ignore.

            logger.info(
                `[Usage] sel=${interaction.customId} user=${interaction.user.id} guild=${interaction.guildId ?? 'DM'}`
            );

            const selectName = componentName(interaction.customId);
            try {
                await withReportingScope(
                    { area: 'select', handler: selectName, guildId: interaction.guildId },
                    () => Sentry.startSpan(
                        { name: `select ${selectName}`, op: 'discord.select' },
                        () => select.execute(interaction, database)
                    )
                );
            } catch (error) {
                logger.error(`[Error] Error executing select ${interaction.customId}`);
                logger.error(error);
                reportError(error, { area: 'select', handler: selectName, guildId: interaction.guildId });
            }
        }
    },
};
