import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    saveDailyVerseConfig,
    readDailyVerseConfig,
    buildDailyVerseConfigView,
} from '../../utils/dailyVerseConfig.js';
import logger from '../../utils/logger.js';

export default {
    id: 'config:daily:hour',
    async execute(interaction, database) {
        if (interaction.customId !== 'config:daily:hour') return;

        const raw = interaction.values?.[0];
        const hour = Number.parseInt(raw, 10);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
            return interaction.reply({ content: 'Invalid hour.', flags: MessageFlags.Ephemeral });
        }

        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) {
            return interaction.reply({
                content: '❌ Only server admins can change daily-verse settings.',
                flags: MessageFlags.Ephemeral,
            });
        }
        if (!interaction.guildId) {
            return interaction.reply({
                content: 'Daily Verse is a per-server setting.',
                flags: MessageFlags.Ephemeral,
            });
        }

        // Ack-budget instrumentation. Kept (at debug) because "This interaction
        // failed" on this panel is a recurring, intermittent report going back
        // to the 2026-07-19 Neon outage, and the two possible causes are
        // indistinguishable from the user's side:
        //
        //   age    = budget already gone before our code ran, from Discord's own
        //            snowflake timestamp. Large here means the interaction was
        //            delivered late — deferring earlier cannot help.
        //   defer  = the ack round-trip itself.
        //   save/read/edit/follow = each subsequent DB or API call.
        //
        // Healthy baseline measured locally: ackBy ~120-165ms against 3000ms.
        // If a future report shows NO line at all, Discord never delivered the
        // interaction and the bot is not involved.
        const t = { age: Date.now() - interaction.createdTimestamp };
        const mark = (k, from) => { t[k] = Date.now() - from; };

        let step = 'deferUpdate';
        try {
            let m = Date.now();
            await interaction.deferUpdate();
            mark('defer', m);

            step = 'save';
            m = Date.now();
            const saved = await saveDailyVerseConfig(database, interaction.guildId, { hour });
            mark('save', m);

            if (!saved) {
                logger.warn(`[ConfigDaily Hour] save returned false — age=${t.age}ms defer=${t.defer}ms save=${t.save}ms`);
                // Already acknowledged, so this must be a followUp, not a reply.
                return interaction.followUp({
                    content: '⚠️ Could not save. Try again in a moment.',
                    flags: MessageFlags.Ephemeral,
                });
            }

            step = 'read';
            m = Date.now();
            const current = await readDailyVerseConfig(database, interaction.guildId);
            mark('read', m);

            step = 'editReply';
            m = Date.now();
            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildDailyVerseConfigView({ current }),
            });
            mark('edit', m);

            step = 'followUp';
            m = Date.now();
            await interaction.followUp({
                content: `✅ Post time set to **${String(hour).padStart(2, '0')}:00 UTC**. Next post at that hour tomorrow (or today if the hour hasn't passed yet).`,
                flags: MessageFlags.Ephemeral,
            });
            mark('follow', m);

            logger.debug(
                `[ConfigDaily Hour] TIMING age=${t.age}ms defer=${t.defer}ms save=${t.save}ms `
                + `read=${t.read}ms edit=${t.edit}ms follow=${t.follow}ms `
                + `ackBy=${t.age + t.defer}ms (budget 3000ms)`
            );
        } catch (err) {
            // Logs the FAILING STEP and the error code, which the previous
            // catch discarded — a bare message hid whether this was 10062
            // (too slow), 40060 (double ack), or a payload rejection.
            logger.error(
                `[ConfigDaily Hour] FAILED at step=${step} code=${err?.code ?? 'none'} status=${err?.status ?? 'none'} `
                + `msg=${err.message} | age=${t.age}ms defer=${t.defer ?? '-'}ms save=${t.save ?? '-'}ms `
                + `read=${t.read ?? '-'}ms edit=${t.edit ?? '-'}ms`
            );
            if (err?.rawError) logger.error(`[ConfigDaily Hour] rawError: ${JSON.stringify(err.rawError)}`);
        }
    },
};
