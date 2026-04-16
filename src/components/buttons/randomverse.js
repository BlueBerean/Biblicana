import { MessageFlags } from 'discord.js';
import { fetchRandomVerseData, buildRandomVerseComponents } from '../../utils/randomVerseRenderer.js';
import logger from '../../utils/logger.js';

export default {
    id: 'randomverse',
    async execute(interaction, database) {
        // customId format: `randomverse:<filterBookId>:<filterChapter>`
        // 0 means "no filter" for either slot. Anyone can click [Another] —
        // random verses are shared territory.
        const parts = interaction.customId.split(':');
        const filterBookId = parts[1] && parts[1] !== '0' ? parseInt(parts[1]) : null;
        const filterChapter = parts[2] && parts[2] !== '0' ? parseInt(parts[2]) : null;

        try {
            await interaction.deferUpdate();

            let preferredTranslation = 'BSB';
            try {
                const userPref = await database.getUserValue(interaction.user.id);
                if (userPref?.translation) preferredTranslation = userPref.translation;
            } catch (dbError) {
                logger.error(`[RandomVerse Button] Failed to get user preference: ${dbError}`);
            }

            const data = await fetchRandomVerseData({ filterBookId, filterChapter, preferredTranslation });
            if (!data) {
                return;
            }

            logger.info(`[RandomVerse Button] Refresh: ${data.bookName} ${data.chapter}:${data.verse} (${data.translation})`);

            await interaction.editReply({
                flags: MessageFlags.IsComponentsV2,
                components: buildRandomVerseComponents({ data, filterBookId, filterChapter })
            });
        } catch (err) {
            logger.error(`[RandomVerse Button] Error: ${err.message}`, err.stack);
        }
    }
};
