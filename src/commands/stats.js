const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Bot and Server Statstics!'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('Stats 📊')
            .setURL(process.env.WEBSITE)
            .setDescription(`These are the current stats for ${interaction.client.user.username}! Please note that these stats are not 100% accurate.`)
            .addFields(
                { name: "Ping", value: `${interaction.client.ws.ping}ms`, inline: true },
                { name: "Uptime", value: `${Math.floor(interaction.client.uptime / 1000 / 60)} minutes`, inline: true },
                { name: "Memory Usage", value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`, inline: true },
                { name: "Shards", value: `${interaction.client.ws.shards.size}`, inline: true },
                { name: "Guilds", value: `${interaction.client.guilds.cache.size}`, inline: true },
                { name: "Users", value: `${interaction.client.users.cache.size}`, inline: true },
            )
            .setColor(eval(process.env.EMBEDCOLOR))
            .setFooter({
                text: process.env.EMBEDFOOTERTEXT,
                iconURL: process.env.EMBEDICONURL
            });
        
        
        return interaction.reply({ embeds: [embed] });
    }
}