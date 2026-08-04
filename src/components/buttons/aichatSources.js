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

    const lookups = (payload.tools ?? []).map(tool => {
        const label = TOOL_LABELS[tool.name] ?? tool.name.replace(/^lookup_/, '').replace(/_/g, ' ');
        return `${label}: ${tool.subject}`;
    });

    const sections = [];
    if (scripture.length) sections.push({ heading: 'Scripture', items: scripture });
    if (commentary.length) sections.push({ heading: 'Commentary', items: commentary });
    if (fathers.length) sections.push({ heading: 'Early Church', items: fathers });
    if (lookups.length) sections.push({ heading: 'Looked up', items: lookups });
    return sections;
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
                    `**${section.heading}**\n${section.items.map(item => `· ${item}`).join('\n')}`
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
