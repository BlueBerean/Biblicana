const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');


module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('How to use the bot!'),
    async execute(interaction) {

        const fields = [
            {
                name: 'Find Scripture', 
                value: 'Use /find with keywords or a phrase to display relevant Bible verses.'
            },
            {
                name: "Commentary Search",
                    value: "Enter /topic plus keywords to access over 25,000 commentaries by Baptist scholar Phil Largent."
                },
            {
                name: "Interlinear Bible Search",
                value: "Use /interlinear for Greek or Hebrew word definitions in a verse."
            },
            {
                name: "Set Bible Version",
                value: "With /setversion, choose and save a preferred translation from 15 options."
            },
            {
                name: "Definitions",
                value: "Type /define for Greek or Hebrew meanings of English words."
            },
            {
                name: "Abbreviation Support",
                value: "Use abbreviations like “Gen” for “Genesis” for book names."
            },
            {
                name: "Bible Verse Access",
                value: "Execute the command /bible followed by your selection of specefic verse(s) for reading."
            }
        ]
        let embed = new EmbedBuilder()
            // Because book is a number representing the book, we need to get the book name fr   the numbersToBook map
            .setTitle(`Help!`)
            .addFields(...fields)
            .setColor(eval(process.env.EMBEDCOLOR))
            .setURL(process.env.WEBSITE)
            .setFooter({
                text: process.env.EMBEDFOOTERTEXT,
                iconURL: process.env.EMBEDICONURL
            });
        
        return interaction.reply({ embeds: [embed], ephemeral: true });
    },
};