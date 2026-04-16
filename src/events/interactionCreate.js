import { Events, EmbedBuilder, MessageFlags } from 'discord.js';
import logger from '../utils/logger.js';

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
            const cooldown = await interaction.client.cooldowns.get(interaction.user.id);

            if (cooldown) {
                const remaining = (cooldown - Date.now()) / 1000;
                if (remaining > 0) {
                    if (interaction.replied) return;

                    const embed = new EmbedBuilder()
                        .setTitle('Slow down! ⏰')
                        .setDescription(`You have to wait ${remaining.toFixed(1)} more seconds before using this command again.`)
                        .setColor(0xff0000)
                        .setFooter({
                            text: process.env.EMBEDFOOTERTEXT,
                            iconURL: process.env.EMBEDICONURL
                        });

                    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                }
            }

            interaction.client.cooldowns.set(interaction.user.id, Date.now() + 3500);

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
                await command.execute(interaction, database);
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.commandName}`);
                logger.error(error);

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
                if (interaction.replied) return;

                if (interaction.customId == "page_next" || interaction.customId == "page_back") return;

                return interaction.reply(`No button matching ${interaction.customId} was found.`);
            }

            // Button usage log. Chain interactions ([Open] → /bible, [Commentary],
            // etc.) matter for understanding UX flow, so they go in the same
            // [Usage] stream as slash commands.
            logger.info(
                `[Usage] btn=${interaction.customId} user=${interaction.user.id} guild=${interaction.guildId ?? 'DM'}`
            );

            try {
                await button.execute(interaction, database);
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.customId}`);
                logger.error(error);
            }
        }
    },
};
