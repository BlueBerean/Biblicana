const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');


module.exports = {
    data: new SlashCommandBuilder()
        .setName('setversion')
        .setDescription('Set the default translation you want to use!')
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use!')
                .setRequired(true)
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" },
                    { name: "CPDV", value: "CPDV" },
                    { name: "DBT", value: "DBT" },
                    { name: "DRB", value: "DRB" },
                    { name: "ERV", value: "ERV" },
                    { name: "JPS/WEY", value: "JPSWEY" },
                    { name: "NHEB", value: "NHEB" },
                    { name: "SLT", value: "SLT" },
                    { name: "WBT", value: "WBT" },
                    { name: "WEB", value: "WEB" },
                    { name: "YLT", value: "YLT" },
                )),
    async execute(interaction, database) {
        const translation = interaction.options.getString('translation') || 'BSB';
        const userid = interaction.user.id;
        const user = await database.getUserValue(userid);

        if (user) {
            database.updateUserValue(userid, {translation: translation});
        } else {
            database.setUserValue(userid, { id: userid, translation: translation });
        }

        let embed = new EmbedBuilder()
            // Because book is a number representing the book, we need to get the book name from the numbersToBook map
            .setTitle(`Set your default translation to ${translation}!`)
            .setDescription(`Your default translation is now ${translation}! If you want to change it, use \`/setversion\` again!`)
            .setColor(eval(process.env.EMBEDCOLOR))
            .setURL(process.env.WEBSITE)
            .setFooter({
                text: process.env.EMBEDFOOTERTEXT,
                iconURL: process.env.EMBEDICONURL
            });
        
        return interaction.reply({ embeds: [embed] });
    },
};