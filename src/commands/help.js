import {
    SlashCommandBuilder,
    ContainerBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ComponentType,
    MessageFlags,
    ApplicationIntegrationType,
    InteractionContextType
} from 'discord.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;

// Category definitions — label shows in the dropdown, body is the detail view.
// Overview is the default landing page.
const CATEGORIES = [
    {
        id: 'overview',
        emoji: '📋',
        label: 'Overview',
        body: [
            '**Biblicana at a glance** — 26 slash commands across 13 categories. Pick a category below to see its commands in detail.',
            '',
            '• **📖 Bible Verse Access** — read verses, random verse, book intros',
            '• **🔍 Find Scripture** — AI-suggested verses by topic',
            '• **📚 Commentary** — 6 classical commentators + Church Fathers',
            '• **🔤 Language Study** — Hebrew/Greek interlinear + lexicon',
            '• **📑 Cross References & Parallel** — TSK + 16 translations',
            '• **🎯 Topical Study** — topical index, word relations, dictionaries, prophecy',
            '• **👤 People & Places** — biblical figures, locations, profiles',
            '• **🔊 Audio Features** — chapter narrations',
            '• **🌐 Web Search** — AI-powered answers with sources',
            '• **⚙️ Settings** — translation preferences',
            '• **📅 Daily Features** — today\'s passage',
            '• **🛠️ Utilities** — ping, stats, help',
            '• **💡 Tips** — usage pointers'
        ].join('\n')
    },
    {
        id: 'bible_access',
        emoji: '📖',
        label: 'Bible Verse Access',
        body: [
            '• `/bible` — Read specific verses. Supports multiple translations and verse ranges.',
            '• `/bookinfo` — Detailed background info on a book of the Bible.',
            '• `/randomverse` — Get a random verse, optionally limited by book/chapter.'
        ].join('\n')
    },
    {
        id: 'find',
        emoji: '🔍',
        label: 'Find Scripture',
        body: '• `/find` — AI suggests relevant Bible verses based on a keyword or phrase.'
    },
    {
        id: 'commentary',
        emoji: '📚',
        label: 'Commentary',
        body: [
            '• `/commentary` — 6 classic commentators (JFB default, or Gill / Matthew Henry / Clarke / Keil & Delitzsch / Tyndale). Verse-level and chapter-level.',
            '• `/fathers` — Early Church Fathers commentary on a passage (334 writers incl. Augustine, Chrysostom, Jerome).',
            '• `/topic` — Search 25,000+ topical commentaries.'
        ].join('\n')
    },
    {
        id: 'language',
        emoji: '🔤',
        label: 'Language Study',
        body: [
            '• `/interlinear` — Greek/Hebrew definitions and transliterations word-by-word.',
            '• `/originaltext` — Original Hebrew/Greek text with pronunciation and morphology.',
            '• `/define` — Look up Greek/Hebrew word meanings by word or Strong\'s number.'
        ].join('\n')
    },
    {
        id: 'xref_parallel',
        emoji: '📑',
        label: 'Cross References & Parallel',
        body: [
            '• `/crossref` — Find related verses (Treasury of Scripture Knowledge, 340k links).',
            '• `/parallel` — Compare one verse in all 16 translations side-by-side.'
        ].join('\n')
    },
    {
        id: 'topical',
        emoji: '🎯',
        label: 'Topical Study',
        body: [
            '• `/topicalindex` — Browse 7,400+ verses grouped by topic.',
            '• `/semantics` — Explore word relationships and meanings.',
            '• `/dictionary` — Easton\'s and Smith\'s Bible Dictionaries.',
            '• `/propheciesofjesus` — Prophecies about Jesus and their fulfillments.'
        ].join('\n')
    },
    {
        id: 'people_places',
        emoji: '👤',
        label: 'People & Places',
        body: [
            '• `/persons` — Biblical figure bios with family, tribe, Strong\'s number.',
            '• `/places` — Biblical locations with coordinates, Google Maps, Wikidata, Pleiades.',
            '• `/profile` — Encyclopedic Tyndale Open Study Notes on figures, groups, and topics.'
        ].join('\n')
    },
    {
        id: 'audio',
        emoji: '🔊',
        label: 'Audio Features',
        body: '• `/audio` — Listen to Bible chapters narrated in KJV with inline action buttons.'
    },
    {
        id: 'web',
        emoji: '🌐',
        label: 'Web Search',
        body: '• `/web` — AI-powered Christian apologetics search with cited sources.'
    },
    {
        id: 'settings',
        emoji: '⚙️',
        label: 'Settings',
        body: '• `/setversion` — Choose your preferred translation from 16 options. Other commands use it as default.'
    },
    {
        id: 'daily',
        emoji: '📅',
        label: 'Daily Features',
        body: '• `/passageoftheday` — Receive today\'s featured Bible passage with chain buttons for commentary, cross-refs, and parallels.'
    },
    {
        id: 'utilities',
        emoji: '🛠️',
        label: 'Utilities',
        body: [
            '• `/ping` — Check bot response time.',
            '• `/stats` — View bot operating statistics.',
            '• `/help` — Show this command guide.'
        ].join('\n')
    },
    {
        id: 'tips',
        emoji: '💡',
        label: 'Tips',
        body: [
            '• Book abbreviations work: `gen`, `jn`, `1co`, `rev`, etc.',
            '• Most commands honor your `/setversion` preference.',
            '• `[📖 Open]` buttons throughout the bot chain into `/bible` with 4 action buttons ([Interlinear] [Commentary] [Cross-refs] [Parallel]).',
            '• Long passages paginate automatically. All pagination buttons time out after 10 minutes.'
        ].join('\n')
    }
];

function buildHelpPage(currentId) {
    const category = CATEGORIES.find(c => c.id === currentId) || CATEGORIES[0];
    const accentColor = process.env.EMBEDCOLOR ? parseInt(process.env.EMBEDCOLOR, 16) : 0x083459;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${category.emoji} ${category.label}`))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(category.body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `-# ${process.env.EMBEDFOOTERTEXT || 'Biblicana'} | Pick any category below to navigate.`
        ));

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category')
            .setPlaceholder('Browse categories…')
            .addOptions(CATEGORIES.map(c => ({
                label: c.label,
                value: c.id,
                emoji: c.emoji,
                default: c.id === currentId
            })))
    );

    return [container, selectRow];
}

export default {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('How to use the bot')
        .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
        .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel),

    async execute(interaction) {
        let currentId = 'overview';
        const flags = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

        await interaction.reply({
            flags,
            components: buildHelpPage(currentId)
        });

        const message = await interaction.fetchReply();
        const filter = i => i.user.id === interaction.user.id && i.customId === 'help_category';
        const collector = message.createMessageComponentCollector({
            filter,
            componentType: ComponentType.StringSelect,
            time: COLLECTOR_TIMEOUT_MS
        });

        collector.on('collect', async i => {
            try {
                await i.deferUpdate();
                currentId = i.values[0];
                await i.editReply({
                    flags,
                    components: buildHelpPage(currentId)
                });
            } catch (err) {
                if (err.code !== 10008 && err.code !== 10062) {
                    // Ignore common timing errors; other errors aren't fatal for this command.
                }
            }
        });
    },
};
