const { SlashCommandBuilder, EmbedBuilder } = require('@discordjs/builders');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('How to use the bot!'),
    async execute(interaction) {

        const fields = [
            {
                name: '📖 Bible Verse Access', 
                value: 'Use `/bible` to read specific verses. Supports multiple translations and verse ranges.'
            },
            {
                name: '🔍 Find Scripture',
                value: 'Use `/find` with keywords or a phrase to display relevant Bible verses.'
            },
            {
                name: "📚 Commentary Search",
                value: "Use `/commentary` to access Gill's Bible Commentary for specific verses.\nUse `/topic` to search over 25,000 topical commentaries."
            },
            {
                name: "🔤 Language Study",
                value: "• `/interlinear` - View Greek/Hebrew definitions and translations\n• `/originaltext` - See original Hebrew/Greek text with analysis\n• `/define` - Look up Greek/Hebrew word meanings"
            },
            {
                name: "📑 Cross References & Parallel",
                value: "• `/crossref` - Find related verses and cross-references\n• `/parallel` - Compare verse translations side by side"
            },
            {
                name: "🎯 Topical Study",
                value: "• `/topicalindex` - Browse verses by topic\n• `/semantics` - Explore word relationships and meanings\n• `/dictionary` - Access Smith's Bible Dictionary"
            },
            {
                name: "🔊 Audio Features",
                value: "Use `/audio` to listen to Bible chapters narrated in KJV."
            },
            {
                name: "🌐 Web Search",
                value: "Use `/web` to search Christian resources with AI-powered answers."
            },
            {
                name: "⚙️ Settings",
                value: "Use `/setversion` to choose your preferred translation from 16 options."
            },
            {
                name: "📅 Daily Features",
                value: "Use `/passageoftheday` to receive today's featured Bible passage."
            },
            {
                name: "💡 Tips",
                value: "• Supports book abbreviations (e.g., 'Gen' for Genesis)\n• Most commands work with multiple Bible translations\n• Use `/randomverse` for random verse inspiration"
            }
        ];

        let embed = new EmbedBuilder()
            .setTitle('📋 Command Guide')
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