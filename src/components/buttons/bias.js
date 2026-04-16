import { EmbedBuilder, MessageFlags } from 'discord.js';
import 'dotenv/config';

export default {
    id: "bias_alert",
    async execute(interaction) {
        try {
            const embedColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0xFFA500;

            const embed = new EmbedBuilder()
                .setTitle('⚠️ AI Response Disclaimer')
                .setDescription('AI suggestions (like those in /find or /web) are based on patterns and may not always perfectly capture theological nuances or full context. Always refer back to Scripture as the primary source.')
                .setColor(embedColor)
                .setFooter({
                    text: process.env.EMBEDFOOTERTEXT,
                    iconURL: process.env.EMBEDICONURL
                });

            await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (error) {
            try {
                if (!interaction.replied) {
                    await interaction.reply({ content: 'Could not display disclaimer due to an error.', flags: MessageFlags.Ephemeral });
                }
            } catch (nestedError) {
                console.error('Error during fallback reply:', nestedError);
            }
        }
    }
};
