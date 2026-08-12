import { MessageFlags, ContainerBuilder, TextDisplayBuilder } from 'discord.js';
import { accentColor, footerLine } from '../../utils/theme.js';
import logger from '../../utils/logger.js';

// [Sources] on an AI chat answer — shows what the answer was actually grounded
// in. Biblicana does a lot of work to keep answers tied to real commentary,
// Church Fathers, lexicons and dictionaries; until now none of that was visible
// to the person reading the reply.
//
// No state in the customId: the button sits on the AI answer itself, so
// interaction.message.id IS the Redis key. That sidesteps the 100-character
// customId cap, which could never have held a source list.
//
// Anyone in the channel may click. The shared per-channel conversation is
// visible to everyone already, the reply is ephemeral so it cannot spam the
// channel, and provenance is exactly the kind of thing that should be easy to
// check rather than gated to whoever happened to ask.

const TOOL_LABELS = {
    lookup_topic: 'Topical index',
    lookup_commentary: 'Commentary',
    lookup_father: 'Church Fathers',
    lookup_scripture: 'Scripture',
    lookup_original: 'Original language',
    lookup_strongs: 'Strong\'s lexicon',
    lookup_crossrefs: 'Cross-references',
    lookup_person: 'Biblical figure',
    lookup_place: 'Place',
    lookup_dictionary: 'Bible dictionary',
    lookup_profile: 'Encyclopedic article',
    // Normally filtered out of "Looked up" in favour of the linked "From the
    // web" section; kept here so a record written before that section existed
    // still renders a readable label rather than a raw tool name.
    search_web: 'Web search',
};

// Father source_title values are frequently stored in shouting caps
// ("SERMON 265B.4"). Title-case the purely alphabetic words so the panel reads
// like a citation rather than a log dump, while leaving alphanumeric tokens
// such as "265B.4" untouched — lowercasing those would be wrong, not just ugly.
function tidyWorkTitle(title) {
    if (!title) return null;
    const text = String(title).trim();
    if (!text) return null;
    if (text !== text.toUpperCase()) return text;   // already mixed case; leave it
    return text
        .split(/(\s+)/)
        .map(token => (/^[A-Z]+$/.test(token)
            ? token.charAt(0) + token.slice(1).toLowerCase()
            : token))
        .join('');
}

function buildSourceLines(payload) {
    const scripture = [];
    const commentary = [];
    const fathers = [];

    for (const entry of payload.rag ?? []) {
        if (entry.translation) scripture.push(`${entry.reference} — ${entry.translation}`);
        if (entry.commentary) commentary.push(`${entry.commentary.author} — ${entry.commentary.work} (on ${entry.reference})`);
        if (entry.father) {
            const work = tidyWorkTitle(entry.father.work);
            fathers.push(`${entry.father.name}${work ? ` — ${work}` : ''} (on ${entry.reference})`);
        }
    }

    // search_web is listed under its own "From the web" heading with real
    // links, so exclude it here — otherwise it appears twice, once as a bare
    // query string and once with its sources.
    const lookups = (payload.tools ?? [])
        .filter(tool => tool.name !== 'search_web')
        .map(tool => {
            const label = TOOL_LABELS[tool.name] ?? tool.name.replace(/^lookup_/, '').replace(/_/g, ' ');
            // The qualifier is the attribution — naming the commentator or
            // Father matters more than naming the verse, since the verse is
            // already obvious from the question.
            return tool.qualifier
                ? `${label}: ${tool.qualifier} — ${tool.subject}`
                : `${label}: ${tool.subject}`;
        });

    // Markdown links rather than bare URLs: the panel should read as citations,
    // and Discord renders these as clickable site names.
    const asLink = source => (source.url ? `[${source.title || source.host}](${source.url})` : (source.title || source.host));
    const webAll = payload.web ?? [];
    const webCited = webAll.filter(source => source.cited).map(asLink);
    const webRetrieved = webAll.filter(source => !source.cited).map(asLink);

    const sections = [];
    if (scripture.length) sections.push({ heading: 'Scripture', items: scripture });
    if (commentary.length) sections.push({ heading: 'Commentary', items: commentary });
    if (fathers.length) sections.push({ heading: 'Early Church', items: fathers });
    if (lookups.length) sections.push({ heading: 'Looked up', items: lookups });
    if (webCited.length) sections.push({ heading: 'From the web', items: webCited });
    // Deliberately a DIFFERENT heading. Without inline citations all we know is
    // that these pages were fetched — a search can return pages unrelated to the
    // question, and listing them as "sources" would claim support the answer
    // never had. Say what actually happened instead.
    if (webRetrieved.length) {
        // Shown in FULL, deliberately. An earlier revision capped this at 5 with
        // an "…and N more" line, on the theory that a long list reads as
        // thorough grounding. That reasoning was backwards: the heading already
        // says these were not necessarily quoted, so showing every site searched
        // is the more transparent option — a reader can see the search swept 11
        // sites and turned up nothing relevant, which is exactly the useful
        // signal. Hiding some of them obscured it.
        //
        // Length is bounded by the per-section character budget in the renderer
        // rather than by an arbitrary item count.
        sections.push({
            heading: 'Sites searched (not necessarily quoted)',
            items: webRetrieved,
        });
    }
    return sections;
}

// Discord rejects a TextDisplay over 4000 characters, and a rejected component
// means the whole Sources reply fails rather than degrading. Sections are shown
// in full up to this budget; only a pathological result set reaches it. At ~70
// characters per source link that is roughly 50 entries, where a realistic
// search returns 4-17.
const SECTION_CHAR_BUDGET = 3800;

function renderSection(section) {
    const header = `**${section.heading}**\n`;
    const lines = [];
    let used = header.length;

    for (let i = 0; i < section.items.length; i++) {
        const line = `· ${section.items[i]}`;
        // Reserve room for the "N more" note so the budget can't be blown by
        // the very line that explains the truncation.
        if (used + line.length + 40 > SECTION_CHAR_BUDGET) {
            lines.push(`_…and ${section.items.length - i} more, omitted for length_`);
            break;
        }
        lines.push(line);
        used += line.length + 1;
    }

    return header + lines.join('\n');
}

export default {
    id: 'aichat_sources',
    async execute(interaction, database) {
        // Ephemeral and cheap, but it still does a Redis read — ack first so a
        // Redis stall can never burn the 3-second window.
        await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

        const payload = await database.getChatSources(interaction.message.id);

        const container = new ContainerBuilder().setAccentColor(accentColor());

        if (!payload) {
            // Either this answer predates the feature, or its record aged out.
            // Say which is possible rather than implying the answer was ungrounded.
            container
                .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Sources'))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    'I no longer have the source record for this answer — it either predates this feature or has aged out.\n\n'
                    + 'Ask again and the new reply will carry its sources.'
                ))
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine()));

            return interaction.editReply({
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                components: [container],
            });
        }

        const sections = buildSourceLines(payload);
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent('## Sources for this answer'));

        if (sections.length === 0) {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                'This answer drew on general knowledge rather than a specific source in the library.'
            ));
        } else {
            for (const section of sections) {
                container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    renderSection(section)
                ));
            }
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '-# These are the texts consulted while composing the reply. Wording and interpretation are the model\'s own.'
            ));
        }

        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(footerLine()));

        logger.debug(`[ChatSources] Rendered ${sections.length} section(s) for message ${interaction.message.id}`);

        return interaction.editReply({
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container],
        });
    },
};
