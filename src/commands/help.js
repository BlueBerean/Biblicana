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
import { accentColor, footerLine, PRIVACY_URL, TERMS_URL } from '../utils/theme.js';
import 'dotenv/config';

const COLLECTOR_TIMEOUT_MS = 600_000;

// Category definitions — label shows in the dropdown, body is the detail view.
// Overview is the default landing page. Exported so non-command surfaces
// (e.g., the welcome card's Help button) can render the same panel.
export const CATEGORIES = [
    {
        id: 'overview',
        emoji: '📋',
        label: 'Overview',
        body: [
            '**Biblicana** — a deep Bible study companion with classic commentary, Church Fathers, AI chat, and more. Pick a category below for details.',
            '',
            '**📖 Study & Reference**',
            '• Bible Verse Access — read verses, random verse, book intros',
            '• Find Scripture — AI-suggested verses by topic',
            '• Commentary — 6 classical commentators + Church Fathers',
            '• Language Study — Hebrew/Greek interlinear + lexicon',
            '• Cross References & Parallel — TSK + 16 translations',
            '• Topical Study — topical index, word relations, dictionaries, prophecy',
            '• People & Places — biblical figures, locations, profiles',
            '• Audio Features — chapter narrations',
            '• Web Search — AI-powered answers with sources',
            '',
            '**💬 Conversation**',
            '• AI Chat — @mention or reply for grounded theological answers',
            '• Right-click Menu — look up scripture straight from any message',
            '',
            '**⚙️ Your Experience**',
            '• Your Preferences — translation default',
            '• Daily Features — today\'s passage + auto-post',
            '',
            '**🛠️ Admin**',
            '• Server Config — passive detection, AI chat, daily verse (admins only)',
            '',
            '**🆘 Help**',
            '• Utilities & Support — ping, stats, help, support server',
            '• Tips — usage pointers',
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
            '• `/commentary` — 6 classic commentators (Adam Clarke default, or Gill / Matthew Henry / JFB / Keil & Delitzsch / Tyndale). Verse-level and chapter-level.',
            '• `/fathers` — Commentary from 334 writers, mostly genuine Early Church Fathers (Augustine, Chrysostom, Jerome). The collection also holds medieval and modern authors; those are labelled with their era so they are never presented as the early church.',
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
        body: [
            '• `/web` — AI-powered Christian apologetics search with cited, clickable sources.',
            '',
            'Searches are restricted to a curated list of trusted Christian reference sites — CCEL, Blue Letter Bible, Bible Hub, STEP Bible, Got Questions, The Gospel Coalition, Desiring God, Ligonier, CARM and others, plus Catholic and Orthodox sources so contested questions can be answered from each tradition\'s own words.',
            '',
            '*Nothing outside that list can reach an answer, so very recent news or niche topics may simply not be covered.*',
        ].join('\n')
    },
    {
        id: 'ai_chat',
        emoji: '🤖',
        label: 'AI Chat',
        body: [
            'Biblicana can chat conversationally, grounded in its own commentary database (Church Fathers + classical commentators).',
            '',
            '**How to trigger it:**',
            '• **@mention** Biblicana in a server channel',
            '• **Reply** to any of Biblicana\'s AI chat messages (no mention needed)',
            '',
            '**Commands:**',
            '• `/forget` — Erase the AI conversation history for your current scope (this channel in shared mode, or your own thread in private mode).',
            '',
            '**How it works:**',
            'When you reference a specific verse, Biblicana pulls the actual commentary (Adam Clarke, Augustine, etc.) into context before answering. It can also look things up mid-conversation — commentary, Church Fathers, cross-references, the Greek or Hebrew, Strong\'s numbers, the topical index, Bible dictionaries, and biblical people and places.',
            '',
            'If the local library has nothing (a ministry\'s current position, a recent event), it can search the same trusted Christian sites `/web` uses. Responses are grounded in real sources, not just generic AI knowledge.',
            '',
            '**Sources button:**',
            'Answers that drew on sources carry a **Sources** button showing exactly what was consulted — which verse, which commentator, which Father, which sites. If an answer has no button, nothing specific was consulted.',
            '',
            '*AI chat must be enabled by a server admin via `/config ai`. Disabled by default for new servers. Admins can also limit it to certain channels, restrict it to specific roles, or block roles from it — so if Biblicana stays silent when you mention it, ask a server admin.*',
        ].join('\n')
    },
    {
        id: 'context_menu',
        emoji: '📌',
        label: 'Right-click Menu',
        body: [
            'Right-click any message → **Apps** → pick a Biblicana action:',
            '',
            '• **Look up scripture** — extracts scripture references from that message and shows the passage with action buttons.',
            '• **Show commentary** — pulls classical commentary (Adam Clarke default) for the first verse reference found.',
            '• **Show interlinear** — shows Hebrew/Greek interlinear view with Strong\'s numbers.',
            '',
            'Works on messages from anyone — including BibleBot posts, your own messages, or someone else\'s quote. A quick way to study a reference without typing slash commands.',
        ].join('\n')
    },
    {
        id: 'preferences',
        emoji: '⚙️',
        label: 'Your Preferences',
        body: [
            '• `/setversion` — Choose your preferred translation from 14 options (BSB, KJV, ASV, WEB, YLT, and more). Other commands honor this automatically.',
            '',
            '*User-scoped — affects only you, syncs across servers.*',
        ].join('\n')
    },
    {
        id: 'server_config',
        emoji: '🛠️',
        label: 'Server Config',
        body: [
            '**Admin-only** (requires Manage Server permission).',
            '',
            '• `/config passive` — Choose how Biblicana reacts when users type scripture references in chat. Modes: `react to BibleBot` (default, coexistence), `react to user messages`, `auto-post verses`, or `silent`.',
            '• `/config ai` — Enable or disable AI chat for this server. Toggle shared-per-channel vs. private-per-user memory scope, limit it to specific channels, and control who may use it with **required roles** (only these roles may chat) and **blocked roles** (a `No AI` role you hand out). Blocked overrules required, and Manage Server bypasses both. Full explanation inside the panel.',
            '• `/config daily` — Enable the Verse of the Day auto-post. Pick a channel and an hour (UTC).',
            '',
            '*Per-server settings persist across bot restarts. New servers see a welcome card on install with quick toggles for each.*',
        ].join('\n')
    },
    {
        id: 'daily',
        emoji: '📅',
        label: 'Daily Features',
        body: [
            '• `/passageoftheday` — Today\'s featured Bible passage with chain buttons for commentary, cross-refs, and parallels.',
            '',
            '**Auto-post (admin-enabled):** Server admins can set Biblicana to post the Verse of the Day automatically each day at a configured time via `/config daily`.',
        ].join('\n')
    },
    {
        id: 'utilities',
        emoji: '🆘',
        label: 'Utilities & Support',
        body: [
            '• `/ping` — Check bot response time.',
            '• `/stats` — View bot operating statistics.',
            '• `/help` — Show this command guide.',
            '• `/support` — Join the Biblicana support server for bug reports, questions, and suggestions.',
            '',
            `**Legal**: [Privacy Policy](${PRIVACY_URL}) · [Terms of Service](${TERMS_URL})`,
        ].join('\n')
    },
    {
        id: 'tips',
        emoji: '💡',
        label: 'Tips',
        body: [
            '• Book abbreviations work: `gen`, `jn`, `1co`, `rev`, etc. Numbered books accept Arabic or Roman (`1 John`, `I John`).',
            '• Most commands honor your `/setversion` preference.',
            '• `[Open]` buttons throughout chain into `/bible` with 4 action buttons (Interlinear / Commentary / Cross-refs / Parallel).',
            '• **Click the book-icon reaction** Biblicana adds to a scripture-bearing message — it opens a study menu with verse text, commentator count, Church Fathers count, and action buttons.',
            '• **Right-click any message** → Apps → Biblicana: fastest way to look up a verse someone else posted.',
            '• **@mention Biblicana** in chat (if the admin enabled AI) for a conversational answer, grounded in actual commentary.',
            '• Long passages and Fathers commentaries paginate automatically. Pagination times out after 10–30 minutes depending on the command.',
            '• Bug reports and suggestions welcome — `/support` gets you to the server where we talk about improvements.',
        ].join('\n')
    }
];

export function buildHelpPage(currentId) {
    const category = CATEGORIES.find(c => c.id === currentId) || CATEGORIES[0];

    // Only the overview carries an emoji in its title — that's the "default
    // view" where the one-emoji-per-header convention lives (each category
    // bullet in the overview body also has its own single emoji). Detail
    // pages keep their titles clean; the emoji still shows up on the
    // category's dropdown option, which is the functional navigation marker.
    const titleLine = category.id === 'overview'
        ? `## ${category.emoji} ${category.label}`
        : `## ${category.label}`;

    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(titleLine))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(category.body))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            footerLine('Pick any category below to navigate.')
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
