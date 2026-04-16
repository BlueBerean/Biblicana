import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('How to use the bot'),
    async execute(interaction) {
        const fields = [
            { name: '📖 Bible Verse Access', value: '• `/bible` - Read specific verses. Supports multiple translations and verse ranges.\n• `/bookinfo` - Get detailed background information about a book of the Bible.\n• `/randomverse` - Get a random verse, optionally limited by book/chapter.' },
            { name: '🔍 Find Scripture', value: 'Use `/find` with keywords or a phrase to display relevant Bible verses.' },
            { name: "📚 Commentary", value: "• `/commentary` - 6 classic commentators (Jamieson-Fausset-Brown default, or pick Gill, Matthew Henry, Clarke, Keil & Delitzsch, or Tyndale). Supports verse-level *and* chapter-level introductions.\n• `/fathers` - Early Church Fathers commentary on a passage (334 writers incl. Augustine, Chrysostom, Jerome, Bede, Tertullian).\n• `/topic` - Search over 25,000 topical commentaries." },
            { name: "🔤 Language Study", value: "• `/interlinear` - View Greek/Hebrew definitions and translations\n• `/originaltext` - See original Hebrew/Greek text with analysis\n• `/define` - Look up Greek/Hebrew word meanings" },
            { name: "📑 Cross References & Parallel", value: "• `/crossref` - Find related verses (Treasury of Scripture Knowledge, 340k links)\n• `/parallel` - Compare verse translations side by side" },
            { name: "🎯 Topical Study", value: "• `/topicalindex` - Browse verses by topic\n• `/semantics` - Explore word relationships and meanings\n• `/dictionary` - Look up terms in Easton's and Smith's Bible Dictionaries\n• `/propheciesofjesus` - View prophecies about Jesus and their fulfillment" },
            { name: "👤 People & Places", value: "• `/persons` - Biblical figure bios with family, tribe, and descriptions\n• `/places` - Biblical locations with coordinates and external references\n• `/profile` - In-depth encyclopedic articles (Tyndale) on key figures, groups, and topics" },
            { name: "🔊 Audio Features", value: "Use `/audio` to listen to Bible chapters narrated in KJV." },
            { name: "🌐 Web Search", value: "Use `/web` to search Christian resources with AI-powered answers." },
            { name: "⚙️ Settings", value: "Use `/setversion` to choose your preferred translation from 16 options." },
            { name: "📅 Daily Features", value: "Use `/passageoftheday` to receive today's featured Bible passage." },
            { name: "🛠️ Utilities", value: "• `/ping` - Check bot response time\n• `/stats` - View bot operating statistics\n• `/help` - Show this command guide" },
            { name: "💡 Tips", value: "• Supports book abbreviations (e.g., 'Gen' for Genesis)\n• Most commands work with multiple Bible translations" }
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
