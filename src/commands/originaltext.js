const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const { getBookId, bibleWrapper, numbersToBook } = require('../utils/bibleHelper');
const logger = require('../utils/logger');
require('dotenv').config();

function generateFooter(translation = "BSB", page, maxPages) {
    return { 
        text: `${process.env.EMBEDFOOTERTEXT} | Translation: ${translation.toUpperCase()} | Page ${page + 1}/${maxPages}`, 
        iconURL: process.env.EMBEDICONURL 
    };
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('originaltext')
        .setDescription('View the original Hebrew/Greek text for a Bible verse')
        .addStringOption(option => 
            option.setName('book')
                .setDescription('The book you want to see the original text for')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('chapter')
                .setDescription('The chapter you want to see the original text for')
                .setRequired(true))
        .addNumberOption(option => 
            option.setName('verse')
                .setDescription('The verse you want to see the original text for')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('translation')
                .setDescription('The translation to show in parallel')
                .addChoices(
                    { name: 'BSB', value: 'BSB' },
                    { name: "NASB", value: "NASB" },
                    { name: 'KJV', value: 'KJV' },
                    { name: "NKJV", value: "NKJV" },
                    { name: 'ASV', value: 'ASV' },
                    { name: "AKJV", value: "AKJV" }
                )),

    async execute(interaction, database) {
        await interaction.deferReply();

        try {
            const defaultTranslation = await database.getUserValue(interaction.user.id);
            const translation = interaction.options.getString('translation') || defaultTranslation?.translation || 'BSB';
            
            const rawBook = interaction.options.getString('book');
            const chapter = parseInt(interaction.options.getString('chapter'));
            const verse = interaction.options.getNumber('verse');

            if (isNaN(chapter) || chapter < 1) {
                return interaction.editReply({ 
                    content: 'Please provide a valid chapter number.',
                    ephemeral: true 
                });
            }

            const bookId = getBookId(rawBook);
            if (!bookId) {
                return interaction.editReply({ 
                    content: `I couldn't find the book "${rawBook}". Please check the spelling or try using the full book name.`, 
                    ephemeral: true 
                });
            }

            const verseId = `${bookId.toString().padStart(2, '0')}${chapter.toString().padStart(3, '0')}${verse.toString().padStart(3, '0')}`;
            logger.info(`[OriginalText Command] Looking up original text for verse ID: ${verseId}`);

            const options = {
                method: 'GET',
                url: 'https://iq-bible.p.rapidapi.com/GetOriginalText',
                params: { verseId },
                headers: {
                    'x-rapidapi-key': process.env.RAPIDAPIKEY,
                    'x-rapidapi-host': 'iq-bible.p.rapidapi.com'
                }
            };

            const [response, englishVerse] = await Promise.all([
                axios.request(options),
                bibleWrapper.getVerses(bookId, chapter, verse, verse)
            ]);

            // Parse the response data if it's a string
            const wordData = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;

            if (!wordData || !Array.isArray(wordData) || wordData.length === 0) {
                return interaction.editReply(`No original text found for ${numbersToBook.get(bookId)} ${chapter}:${verse}.`);
            }

            if (!englishVerse || englishVerse.length === 0) {
                return interaction.editReply('Error: Could not fetch the English verse text.');
            }

            // Create pages from the original text data
            const maxChars = 1900;
            const pages = [];
            let currentPage = '';

            // Add English translation
            currentPage += `**${numbersToBook.get(bookId)} ${chapter}:${verse} (${translation})**\n${englishVerse[0][translation]}\n\n`;

            // Add original text section with language-specific emoji
            const isNewTestament = bookId > 39;
            currentPage += `**${isNewTestament ? '🇬🇷 Greek' : '🕎 Hebrew'}:**\n${wordData.map(w => w.word).join(' ')}\n\n`;

            // Add pronunciation guide with emoji
            currentPage += `**🗣️ Pronunciation Guide:**\n`;
            for (const word of wordData) {
                try {
                    const pronun = JSON.parse(word.pronun);
                    const wordEntry = `‎${word.word} (${pronun.dic_mod || pronun.dic})\n`;
                    
                    if ((currentPage + wordEntry).length > maxChars) {
                        pages.push(currentPage);
                        currentPage = wordEntry;
                    } else {
                        currentPage += wordEntry;
                    }
                } catch (e) {
                    logger.error('[OriginalText Command] Error parsing pronunciation:', e);
                }
            }

            // Add word-by-word analysis with emoji
            currentPage += `\n**📝 Word Analysis:**\n`;
            for (const word of wordData) {
                const strongsPrefix = isNewTestament ? 'G' : 'H';
                const wordEntry = `‎${word.word} - ${strongsPrefix}${word.strongs}${word.morph ? ` (${word.morph})` : ''}\n`;
                
                if ((currentPage + wordEntry).length > maxChars) {
                    pages.push(currentPage);
                    currentPage = wordEntry;
                } else {
                    currentPage += wordEntry;
                }
            }

            // Add notes section with emoji (if notes exist)
            const notesWithContent = wordData.filter(w => w.notes);
            if (notesWithContent.length > 0) {
                currentPage += `\n**📌 Notes:**\n`;
                for (const word of notesWithContent) {
                    const noteEntry = `‎${word.word}: ${word.notes}\n`;
                    
                    if ((currentPage + noteEntry).length > maxChars) {
                        pages.push(currentPage);
                        currentPage = noteEntry;
                    } else {
                        currentPage += noteEntry;
                    }
                }
            }

            if (currentPage) {
                pages.push(currentPage);
            }

            // Add a note about using /interlinear for definitions
            currentPage += `\n*For detailed Strong's definitions, use the /interlinear command.*`;

            if (pages.length === 0) {
                return interaction.editReply(`No detailed analysis available for ${numbersToBook.get(bookId)} ${chapter}:${verse}.`);
            }

            let currentPageIndex = 0;
            const embed = new EmbedBuilder()
                .setTitle(`📜 Original Text Analysis - ${numbersToBook.get(bookId)} ${chapter}:${verse}`)
                .setDescription(pages[0])
                .setColor(eval(process.env.EMBEDCOLOR))
                .setURL(process.env.WEBSITE)
                .setFooter(generateFooter(translation, currentPageIndex, pages.length));

            if (pages.length === 1) {
                return interaction.editReply({ embeds: [embed] });
            }

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('page_back')
                        .setEmoji('◀️')
                        .setLabel('Previous')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId('page_next')
                        .setEmoji('▶️')
                        .setLabel('Next')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(false)
                );

            const message = await interaction.editReply({ 
                embeds: [embed], 
                components: [row] 
            });

            const collector = message.createMessageComponentCollector({
                time: 600000
            });

            collector.on('collect', async i => {
                if (i.user.id !== interaction.user.id) {
                    await i.reply({ content: 'You cannot use this button!', ephemeral: true });
                    return;
                }

                if (i.customId === 'page_next') {
                    currentPageIndex++;
                    if (currentPageIndex > (pages.length - 1)) currentPageIndex = 0;
                } else if (i.customId === 'page_back') {
                    currentPageIndex--;
                    if (currentPageIndex < 0) currentPageIndex = pages.length - 1;
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('page_back')
                            .setEmoji('◀️')
                            .setLabel('Previous')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === 0),
                        new ButtonBuilder()
                            .setCustomId('page_next')
                            .setEmoji('▶️')
                            .setLabel('Next')
                            .setStyle(ButtonStyle.Secondary)
                            .setDisabled(currentPageIndex === pages.length - 1)
                    );

                embed.setDescription(pages[currentPageIndex])
                     .setFooter(generateFooter(translation, currentPageIndex, pages.length));

                await i.update({ embeds: [embed], components: [row] });
            });

        } catch (error) {
            logger.error('[OriginalText Command] Error:', error);
            logger.error('[OriginalText Command] API Response:', error.response?.data);
            await interaction.editReply({ 
                content: 'Sorry, there was an error processing your request. Please try again later.',
                ephemeral: true 
            });
        }
    }
}; 