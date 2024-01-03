const { EmbedBuilder } = require('discord.js');

module.exports = {
    id: "define_alert",
    execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('Alert!')
            .setDescription('This command may not yield the correct results. I am currently working on a better solution, but for the beta this will have to work...')
            .setColor(eval(process.env.EMBEDCOLOR))
            .setFooter({
                text: process.env.EMBEDFOOTERTEXT,
                iconURL: process.env.EMBEDICONURL
            });

        return interaction.reply({ embeds: [embed], ephemeral: true })
    }
}