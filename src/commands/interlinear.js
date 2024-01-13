const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } = require('discord.js');
const splitString = require('../utils/splitString');
const { bibleWrapper, books, strongsWrapper, numbersToBook } = require('../utils/bibleHelper.js')

module.exports = {
    data: new SlashCommandBuilder()
        .setName('interlinear')
        .setDescription('Find a specific verse in the interlinear bible!')
        .addStringOption(option => option.setName('book').setDescription('The book you want to find a verse for!').setRequired(true))
        .addStringOption(option => option.setName('chapter').setDescription('The chapter you want to find a verse for!').setRequired(true))
        .addNumberOption(option => option.setName('verse').setDescription('The verse you want to find!').setRequired(true))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation you want to use in parallel!')
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
        
        const defaultTranslation = (await database.getUserValue(interaction.user.id))?.translation || 'BSB';
        const translation = interaction.options.getString('translation') || defaultTranslation;

        const book = interaction.options.getString('book')
        const chapter = interaction.options.getString('chapter');
        const verseNumber = interaction.options.getNumber('verse');

        const bookid = books.get(book.toLowerCase());

        if (!bookid) {
            return interaction.reply({ content: 'I couldn\'t find that book!', ephemeral: true });
        }

        const verse = await bibleWrapper.getInterlinearVerse(bookid, chapter, verseNumber);
        if (!verse) return interaction.editReply({ content: `I couldn't find any verses related to ${book} ${chapter}:${verseNumber}!` });

        const data = JSON.parse(verse.data);

        let verseText = "";
        let strongsNumbers = [];
        let verseEnglish = [];

        const character = data[0].number.match(/[a-zA-Z]+/)[0];

        for (const item of data) {
            verseText += `${item.word}   `;
            const character = item.number.match(/[a-zA-Z]+/)[0];
            const numbers = item.number.match(/\d+/)[0];

            const strongs = await strongsWrapper.getStrongsId(character === "g" ? "Greek" : "Hebrew", numbers);
            
            const strongsInfo = strongs
                ? `${item.number} - ${item.word} (${character === "g" ? strongs.translit || "NONE" : strongs.xlit || "NONE"}) - ${strongs.strong_def || "NONE"}`
                : `${item.number} - ${item.word} - No definition available`;

            strongsNumbers.push(strongsInfo);
            verseEnglish.push(`${item.text}   `); // Add 3 spaces to make it look better for the reverse text
        }

        let englishVerses = await bibleWrapper.getVerses(bookid, chapter, verseNumber, verseNumber);
        englishVerses.sort((a, b) => a.verse - b.verse);

        let englishResponse = "";
        for (let i = 0; i < englishVerses.length; i++) {
            let number = i + verseNumber;

            if (englishResponse.length > 1) {
                englishResponse += " ";
            }

            englishResponse += `<**${number}**> ${englishVerses[i][translation]}`;
        }

        //const fullResponse = `${englishResponse} **${numbersToBook.get(bookid)} ${chapter}:${verseNumber} ${translation}**\n\n**${character === "g" ? "Greek" : "Hebrew"}:** ${verseText}\n\n**${character === "g" ? "KJV (Left to Right)" : "KJV (Right to Left)"}**\n ${character === "g" ? verseEnglish.join("") : verseEnglish.reverse().join("")}\n\n\n**Strongs**\n>>> ${strongsNumbers.join("\n")}`;

        const splitResponse = splitString(strongsNumbers.join("\n"), 1000);

        const embed = new EmbedBuilder()
            .setTitle(`${numbersToBook.get(bookid)} ${chapter}:${verseNumber} ${translation}`)
            .setDescription(englishResponse)
            .setFields([
                { name: character === "g" ? "Greek" : "Hebrew", value: verseText },
                { name: `${character === "g" ? "KJV (Left to Right)" : "KJV (Right to Left)"}`, value: `${character === "g" ? verseEnglish.join("") : verseEnglish.join("")}` },
                { name: "Strongs", value: splitResponse[0] }
            ])
            .setColor(eval(process.env.EMBEDCOLOR))
            
        
        if (splitResponse.length > 1) {
           let currentPage = 0;

            const paginationButtons = [
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("⬅️").setCustomId("page_back"),
                new ButtonBuilder().setStyle(ButtonStyle.Primary).setEmoji("➡️").setCustomId("page_next")
            ];

            const row = new ActionRowBuilder()
                .addComponents(...paginationButtons);

            const defaultFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Page 1/${splitResponse.length}`, iconURL: process.env.EMBEDICONURL };
            const response = await interaction.editReply({
                embeds: [embed.setFooter(defaultFooter)],
                components: [row],
            });

            const collector = response.createMessageComponentCollector({ componentType: ComponentType.Button, time: 1_800_000 });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) return i.reply({ content: 'You cannot use this button!', ephemeral: true });

                const selection = i.customId;

                currentPage = (selection === "page_back") 
                    ? (currentPage === 0 ? splitResponse.length - 1 : currentPage - 1)
                    : (currentPage === splitResponse.length - 1 ? 0 : currentPage + 1);

                embed.data.fields[2].value = splitResponse[currentPage]; 
                const pageFooter = { text: process.env.EMBEDFOOTERTEXT + ` | Page ${currentPage + 1}/${splitResponse.length}`, iconURL: process.env.EMBEDICONURL };

                await i.update({ embeds: [embed.setFooter(pageFooter)] });
            });
        } else {
            
            return interaction.editReply({ embeds: [embed.setFooter({text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL})] });
        }
    },
};
