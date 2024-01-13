const { SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType} = require('discord.js');
const swearWordFilter = require('../utils/filter');
const axios = require('axios');
const { numbersToBook, books, bibleWrapper } = require("../utils/bibleHelper.js");
const logger = require('../utils/logger');

function generateFooter(translation = "BSB", page, maxPages = 2) {
    return { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, iconURL: process.env.EMBEDICONURL };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('find')
        .setDescription('Find a specific verse related to a topic!')
        .addStringOption(option => option.setName('topic').setDescription('The topic you want to find a verse for!').setRequired(true).setMinLength(3).setMaxLength(250))
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
        await interaction.deferReply();

        const defaultTranslation = await database.getUserValue(interaction.user.id)
        const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';

        const requestedTopic = swearWordFilter(interaction.options.getString('topic'));

        let apiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
            "model": "gpt-3.5-turbo",
            "messages": [{
                "role": "user", "content": `This must be valid JSON format, do not terminate it before completing. please respond with verses about this topic from a protestant perspective, ${requestedTopic}, in this JSON format with no other text please: [{ "book": "<abbreviated name>"
        , "chapter": "<chapter number>", "startVerse": "<verse number>", "endVerse": "<verse number>" }, {<next one>}]. You may also include up to 5 verses in your output. Please only use these abbreviated names for the books in the bible [  'gen', 'exo', 'lev', 'num', 'deu', 'jos',  'jdg', 'rut', '1sa', '2sa', '1ki', '2ki',  '1ch', '2ch', 'ezr', 'neh', 'est', 'job',  'psa', 'pro', 'ecc', 'sos', 'isa', 'jer',  'lam', 'eze', 'dan', 'hos', 'joe', 'amo',  'oba', 'jon', 'mic', 'nah', 'hab', 'zep',  'hag', 'zec', 'mal', 'mat', 'mar', 'luk',  'joh', 'act', 'rom', '1co', '2co', 'gal',  'eph', 'php', 'col', '1th', '2th', '1ti',  '2ti', 'tit', 'phm', 'heb', 'jam', '1pe',  '2pe', '1jo', '2jo', '3jo', 'jde', 'rev']` }],
            "temperature": 0.7
        }, {
            headers: {
                'content-type': 'application/json',
                'Authorization': 'Bearer ' + process.env.OPENAIKEY
            }
        });

        if (apiResponse.data?.error) { 
            return logger.warn(apiResponse.data.error);
        }

        let parsedVerses;
        try {
            parsedVerses = JSON.parse(apiResponse.data.choices[0].message.content) // if this is invalid, it might fail and kill the program
        } catch (error) {
            return interaction.editReply({ content: `I couldn't find any verses about ${requestedTopic}!` });
        }

        if (parsedVerses.length == 0) {
            return interaction.editReply({ content: `I couldn't find any verses about ${requestedTopic}!` });
        }

        for (const verse of parsedVerses) {
            const book = verse.book.toLowerCase();
            const bookId = books.get(book);
            const chapter = verse.chapter;
            const startVerse = parseInt(verse.startVerse);
            const endVerse = parseInt(verse.endVerse) || startVerse; 

            if (!bookId || !chapter || !startVerse) { // There MUST be a book, chapter, and startVerse
                continue;
            }

            let versesFromAPI = await bibleWrapper.getVerses(bookId, chapter, startVerse, endVerse);

            if (versesFromAPI.length == 0) { // If there are no verse data, skip this verse
                continue;
            }

            let response = versesFromAPI.map((verse, index) => {
                const number = index + startVerse;
                return (index > 0 ? ` <**${number}**> ` : "") + verse[translation]; // If it's not the first verse, add a space before it and the number
            }).join("");

            verse.text = response;
        }

        let description = [];
        for (const verse of parsedVerses) {
            const prettyBookName = numbersToBook.get(books.get(verse.book.toLowerCase()));
            const verseRange = verse.endVerse && verse.startVerse != verse.endVerse ? `-${verse.endVerse}` : ""; // If there is an endVerse and it's not the same as the startVerse, add it to the range
            description.push(`**${prettyBookName} ${verse.chapter}:${verse.startVerse}${verseRange}**: ${verse.text ?? "No verse found"}\n`);
        }

        const embed = new EmbedBuilder()
            .setTitle(`Verses regarding "${requestedTopic}"`)
            .setColor(eval(process.env.EMBEDCOLOR))
            .setURL(process.env.WEBSITE);

        if (description.length == 0) {
            return interaction.editReply({ content: `I couldn't find any verses about ${requestedTopic}!` });
        }

        const maxVerses = 2;
        const maxChars = 1900;

        let pages = [];
        let tempArr = [];
        for (const index of description) { // When it loops through, it will use index instead of value
            if (tempArr.length === maxVerses) {
                pages.push(tempArr);
                tempArr = [];
            }

            tempArr.push(index);
        }

        if (tempArr.length > 0) { // If the pages don't divide evenly, add the remaining verses to the last page
            pages.push(tempArr); 
        }

        if (pages.length > 1) {
            const paginationButtons = [
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("⬅️").setCustomId("page_back"),
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("➡️").setCustomId("page_next"),
                new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Disclaimer").setCustomId("bias_alert")
            ];

            const row = new ActionRowBuilder().addComponents(...paginationButtons);

            let currentPage = 0;

            const response = await interaction.editReply({
                embeds: [embed
                    .setFooter(generateFooter(translation, currentPage, pages.length))
                    .setDescription(pages[0].join(" ").slice(0, maxChars))], // Slice to maxVerses then join and slice to maxChars in case the first verse is too long
                components: [row],
            });

            const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 1_800_000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'You cannot use this button!', ephemeral: true });

                if (i.customId === 'page_next') {
                    currentPage++;
                    if (currentPage > (pages.length - 1)) currentPage = 0; // currentPage is 0 indexed, so the last page is pages.length - 1
                } else if (i.customId === 'page_back') {
                    currentPage--;
                    if (currentPage < 0) currentPage = pages.length - 1;
                }

                await i.update({ embeds: [embed
                    .setFooter(generateFooter(translation, currentPage, pages.length))
                    .setDescription(pages[currentPage].join(" ").slice(0, maxChars)) // Same thing as above, slice to the maxChars in case the strings are too long
                ], components: [row] });
            });
        } else {
            const defaultFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Translation: ${translation.toUpperCase()}`, iconURL: process.env.EMBEDICONURL };
            embed.setFooter(defaultFooter).setDescription(pages.join(" "));

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Disclaimer").setCustomId("bias_alert")
            );

            return interaction.editReply({ embeds: [embed], components: [row] });
        }
        
    },
};
