const { SlashCommandBuilder } = require('@discordjs/builders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies with the Ping!'),
    async execute(interaction) {
        return interaction.reply({ content: `Ping! ${interaction.client.ws.ping}MS` });
    },
};