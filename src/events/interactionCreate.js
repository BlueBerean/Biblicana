const { Events, EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
module.exports = {
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

                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
            }

            interaction.client.cooldowns.set(interaction.user.id, Date.now() + 3500);
            
            const command = interaction.client.commands.get(interaction.commandName);

            if (!command) {
                if (interaction.replied) return;

                interaction.reply(`No command matching ${interaction.commandName} was found.`);
                return;
            }

            try {
                await command.execute(interaction, database);
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.commandName}`);
                logger.error(error);
            }
        } else if (interaction.isButton()) {
            const button = interaction.client.buttons.get(interaction.customId);

            if (!button) {
                if (interaction.replied) return;

                if (interaction.customId == "page_next" || interaction.customId == "page_back") return; // These are handled in the individual commands

                interaction.reply(`No button matching ${interaction.customId} was found.`);
                return;
            }

            try {
                await button.execute(interaction);
            } catch (error) {
                logger.error(`[Error] Error executing ${interaction.customId}`);
                logger.error(error);
            }
        } else {
            return;
        }
	},
};