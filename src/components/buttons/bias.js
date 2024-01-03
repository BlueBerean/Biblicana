const { EmbedBuilder } = require('discord.js');

module.exports = {
    id: "bias_alert",
    execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('Warning: Results may not be contextual.')
            .setDescription('Biblicana uses a LLM (Large Language Model) to select verses. While the verses are accurate, the context of the results may vary. Always check original source for context. For support, please email hello@biblicana.org')
            .setColor(eval(process.env.EMBEDCOLOR))
            .setFooter({
                text: process.env.EMBEDFOOTERTEXT,
                iconURL: process.env.EMBEDICONURL
            });

        return interaction.reply({ embeds: [embed], ephemeral: true })
    }
}