const { SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } = require('discord.js');
const { bibleWrapper, books, strongsWrapper, numbersToBook, getBookId } = require('../utils/bibleHelper.js')
const logger = require('../utils/logger');

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
        let isDeferred = false;
        let hasResponded = false;
        
        try {
            const rawBook = interaction.options.getString('book');
            const chapter = interaction.options.getString('chapter');
            const verseNumber = interaction.options.getNumber('verse');

            // Validate inputs synchronously before any async operations
            if (!rawBook || !chapter || !verseNumber) {
                hasResponded = true;
                return interaction.reply({ 
                    content: 'Please provide all required parameters (book, chapter, and verse).', 
                    ephemeral: true 
                });
            }

            // Defer first since we'll be doing async operations
            await interaction.deferReply();
            isDeferred = true;
            hasResponded = true;

            // Then validate the book
            const bookid = getBookId(rawBook);
            if (!bookid) {
                logger.warn(`[Interlinear Command] Invalid book name: ${rawBook}`);
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Try using common abbreviations like "gen", "exo", "mat", "mrk", "1 cor", "rev" or the full name.`, 
                    ephemeral: true 
                });
            }

            const defaultTranslation = (await database.getUserValue(interaction.user.id))?.translation || 'BSB';
            const translation = interaction.options.getString('translation') || defaultTranslation;

            logger.info(`[Interlinear Command] Processing request for ${rawBook} ${chapter}:${verseNumber}`);

            // Get verse data with timeout
            const verse = await Promise.race([
                bibleWrapper.getInterlinearVerse(bookid, chapter, verseNumber),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout getting verse')), 5000)
                )
            ]);

            if (!verse) {
                return interaction.editReply({ 
                    content: `I couldn't find any verses related to ${numbersToBook.get(bookid)} ${chapter}:${verseNumber}!`,
                    ephemeral: true 
                });
            }

            // Parse verse data
            let data;
            try {
                data = JSON.parse(verse.data);
                logger.info(`[Interlinear Command] Successfully parsed verse data`);
            } catch (error) {
                logger.error(`[Interlinear Command] Error parsing verse data: ${error.message}`);
                throw new Error('Failed to parse verse data');
            }

            // Process verse data
            let verseText = "";
            let strongsNumbers = [];
            let verseEnglish = [];
            let character = data[0].number.match(/[a-zA-Z]+/)[0];

            // Process all Strong's numbers in parallel
            const strongsPromises = data.map(async (item) => {
                verseText += `${item.word} | `;
                character = item.number.match(/[a-zA-Z]+/)[0];
                const numbers = item.number.match(/\d+/)[0];

                try {
                    const strongs = await strongsWrapper.getStrongsId(
                        character === "g" ? "Greek" : "Hebrew", 
                        numbers
                    );

                    const strongsInfo = strongs
                        ? `• ${item.number} - ${item.word} (${character === "g" ? strongs.translit || "NONE" : strongs.xlit || "NONE"})\n  ${strongs.strong_def || "NONE"}`
                        : `• ${item.number} - ${item.word}\n  No definition available`;

                    strongsNumbers.push(strongsInfo);
                    verseEnglish.push(`${item.text} | `);
                } catch (error) {
                    logger.error(`[Interlinear Command] Error getting Strong's data: ${error.message}`);
                    strongsNumbers.push(`• ${item.number} - ${item.word}\n  Error getting definition`);
                    verseEnglish.push(`${item.text} | `);
                }
            });

            // Add timeout for Strong's lookups
            const strongsTimeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Strong\'s lookup timeout')), 8000)
            );

            try {
                await Promise.race([
                    Promise.all(strongsPromises),
                    strongsTimeout
                ]);
            } catch (error) {
                logger.error(`[Interlinear Command] Strong's lookup timed out or failed: ${error.message}`);
                // Continue with partial data
            }

            // Get English verses
            const englishVerses = await bibleWrapper.getVerses(bookid, chapter, verseNumber, verseNumber);
            englishVerses.sort((a, b) => a.verse - b.verse);

            // Create response
            let englishResponse = englishVerses.map((verse, i) => 
                `<**${i + verseNumber}**> ${verse[translation]}`
            ).join(" ");

            // Create Strong's pages
            let strongsPages = [];
            let tempArr = [];
            for (const strongsNumber of strongsNumbers) {
                if (tempArr.join("\n\n").length + strongsNumber.length > 1000) {
                    strongsPages.push(tempArr.join("\n\n"));
                    tempArr = [];
                }
                tempArr.push(strongsNumber);
            }
            if (tempArr.length > 0) {
                strongsPages.push(tempArr.join("\n\n"));
            }

            // Create embed
            const embed = new EmbedBuilder()
                .setTitle(`${numbersToBook.get(bookid)} ${chapter}:${verseNumber} ${translation}`)
                .setDescription(`*English Translation*\n${englishResponse}`)
                .setFields([
                    { 
                        name: `📜 Original ${character === "g" ? "Greek" : "Hebrew"}`, 
                        value: `\`\`\`${verseText.slice(0, -3)}\`\`\``,
                        inline: false 
                    },
                    { 
                        name: `🔄 Transliteration (${character === "g" ? "Left to Right" : "Right to Left"})`, 
                        value: `\`\`\`${character === "g" 
                            ? verseEnglish.join("").slice(0, -3) 
                            : verseEnglish.reverse().join("").slice(0, -3)}\`\`\``,
                        inline: false 
                    },
                    { 
                        name: "📚 Strong's Concordance", 
                        value: strongsPages[0],
                        inline: false 
                    }
                ])
                .setColor(eval(process.env.EMBEDCOLOR));

            if (strongsPages.length > 1) {
                let currentPage = 0;

                const paginationButtons = [
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("◀️")
                        .setLabel("Previous")
                        .setCustomId("page_back"),
                    new ButtonBuilder()
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji("▶️")
                        .setLabel("Next")
                        .setCustomId("page_next")
                ];

                const row = new ActionRowBuilder()
                    .addComponents(...paginationButtons);

                const defaultFooter = { 
                    text: `${process.env.EMBEDFOOTERTEXT} • Strong's Concordance Page 1/${strongsPages.length}`, 
                    iconURL: process.env.EMBEDICONURL 
                };
                const response = await interaction.editReply({
                    embeds: [embed.setFooter(defaultFooter)],
                    components: [row],
                });

                try {
                    const collector = response.createMessageComponentCollector({ 
                        componentType: ComponentType.Button, 
                        time: 1_800_000 
                    });

                    collector.on('collect', async i => {
                        try {
                            if (i.user.id !== interaction.user.id) {
                                return i.reply({ content: 'You cannot use this button!', ephemeral: true });
                            }
                            const selection = i.customId;

                            if (selection === 'page_next') {
                                currentPage++;
                                if (currentPage > (strongsPages.length - 1)) currentPage = 0; // currentPage is 0 indexed, so the last page is pages.length - 1
                            } else if (selection === 'page_back') {
                                currentPage--;
                                if (currentPage < 0) currentPage = strongsPages.length - 1;
                            }

                            embed.data.fields[2].value = strongsPages[currentPage];
                      
                            const pageFooter = { 
                                text: `${process.env.EMBEDFOOTERTEXT} • Strong's Concordance Page ${currentPage + 1}/${strongsPages.length}`, 
                                iconURL: process.env.EMBEDICONURL 
                            };

                            await i.update({ embeds: [embed.setFooter(pageFooter)] });
                        } catch (error) {
                            logger.error(`[Interlinear Command] Error in collector: ${error.message}`);
                        }
                    });
                } catch (error) {
                    logger.error(`[Interlinear Command] Error setting up collector: ${error.message}`);
                }
            } else {
                
                return interaction.editReply({ embeds: [embed.setFooter({text: process.env.EMBEDFOOTERTEXT, iconURL: process.env.EMBEDICONURL})] });
            }

        } catch (error) {
            logger.error(`[Interlinear Command] Error processing request: ${error.message}`);
            
            try {
                if (!hasResponded) {
                    await interaction.reply({ 
                        content: 'Sorry, there was an error processing your request.',
                        ephemeral: true 
                    });
                } else if (isDeferred) {
                    await interaction.editReply({ 
                        content: 'Sorry, there was an error processing your request.',
                        ephemeral: true 
                    });
                }
            } catch (e) {
                if (e.code !== 10062 && e.code !== 40060) {
                    logger.error(`[Interlinear Command] Could not send error message: ${e.message}`);
                }
            }
        }
    },
};
