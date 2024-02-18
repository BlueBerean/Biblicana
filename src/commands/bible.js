const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');
const { books, bibleWrapper, numbersToBook } = require('../utils/bibleHelper.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bible')
        .setDescription('Find a specific verse in the bible!')
        .addStringOption(option => option.setName('book').setDescription('The book you want to find a verse for!').setRequired(true))
        .addStringOption(option => option.setName('chapter').setDescription('The chapter you want to find a verse for!').setRequired(true))
        .addNumberOption(option => option.setName('startverse').setDescription('The range of verses you want to find!').setRequired(true))
        .addNumberOption(option => option.setName('endverse').setDescription('The range of verses you want to find'))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use!')
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
        const defaultTranslation = await database.getUserValue(interaction.user.id);
        
        const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';

        const book = interaction.options.getString('book').toLowerCase().split(" ").join(""); // Remove spaces
        const chapter = interaction.options.getString('chapter');
        const startVerse = interaction.options.getNumber('startverse');
        const endVerse = interaction.options.getNumber('endverse') || startVerse;

        const bookid = books.get(book);
        
        if (!bookid) {
            return interaction.reply({ content: 'I couldn\'t find that book!', ephemeral: true });
        }

        if (startVerse > endVerse) {
            return interaction.reply({ content: 'The start verse cannot be greater than the end verse!', ephemeral: true });
        }

        let verses = await bibleWrapper.getVerses(bookid, chapter, startVerse, endVerse, translation);

        if (!verses.length > 0) return interaction.reply({ content: `I couldn't find any verses related to ${book} ${chapter}:${startVerse}${endVerse && startVerse != endVerse ? "-" + endVerse :  ""}!`, ephemeral: true });
        
        verses.sort((a, b) => a.verse - b.verse);
        
        // Empty string for response
        let response = "";
        for (let i = 0; i < verses.length; i++) {
            // i starts at 0, so add to get the actual verse number
            let number = i + startVerse;

            // Add a space if not the first verse!
            if (response.length > 1) {
                response += " ";
            }

            if (response.length + verses[i][translation].length > 1900) {
                response = "**The response was too long! Please try again with a smaller range of verses. Here is all I can post:**\n\n" + response;
                break ;
            }

            response += "<**" + number + "**> " + verses[i][translation];
        }

        let embed = new EmbedBuilder()
            // Because book is a number representing the book, we need to get the book name from the numbersToBook map
            .setTitle(`${numbersToBook.get(bookid)} ${chapter}:${startVerse}${endVerse && startVerse != endVerse ? "-" + endVerse :  ""}`)
            .setDescription(response)
            .setColor(eval(process.env.EMBEDCOLOR))
            .setURL(process.env.WEBSITE)
            .setFooter({ 
                text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`, 
                icon_url: process.env.EMBEDICONURL 
            });
        
        return interaction.reply({ embeds: [embed] });
    },
};