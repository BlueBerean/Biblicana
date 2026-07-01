import {
    ContainerBuilder,
    SectionBuilder,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} from 'discord.js';
import { accentColor, footerLine, SUPPORT_INVITE, PRIVACY_URL, TERMS_URL } from './theme.js';
import { AI_OPTIONS } from './aiConfig.js';

// Label lookup for passive modes. Defined here (not in the schema) so the
// DB stays language-agnostic while the UI surfaces friendly names.
const PASSIVE_MODE_OPTIONS = [
    {
        value: 'react_biblebot',
        label: 'React to BibleBot posts',
        description: 'Best when BibleBot is also here. Adds 📖 for commentary.',
    },
    {
        value: 'autopost',
        label: 'Auto-post verses',
        description: 'Best when BibleBot is not installed. Posts verses inline.',
    },
    {
        value: 'react_user',
        label: 'React to user messages directly',
        description: 'Adds 📖 on any message mentioning scripture.',
    },
    {
        value: 'silent',
        label: 'Silent mode',
        description: 'Never react. Users still have slash commands.',
    },
];

/**
 * Build the Components V2 tree for the welcome / setup card.
 * Pure function of the current passive-mode selection; the event handler
 * and the dev-only /testwelcome command both call this with the stored
 * (or default) mode so the select menu renders with the correct item marked
 * `default`.
 */
export function buildWelcomeCard({ currentPassiveMode = 'react_biblebot', currentAiEnabled = false, currentDailyEnabled = false } = {}) {
    const container = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '## 👋 Welcome to Biblicana'
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                'Thanks for adding me! I\'m a Bible study bot built on a **deep library of classic commentary** —',
                '**334 Early Church Fathers**, **six classic commentators** (Gill, Henry, Clarke, JFB, Keil, Tyndale),',
                '**340k cross-references**, interlinear Hebrew/Greek, and more.',
                '',
                'Here\'s a 10-second tour. Click any button to see it in action.',
            ].join('\n')
        ))
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Find**\n-# Can\'t remember a specific verse number? AI suggests relevant verses by topic.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:find')
                .setLabel('Try it')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Random verse**\n-# See a random verse with translation options.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:random')
                .setLabel('Try it')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Interlinear — John 3:16**\n-# Hebrew/Greek word-by-word with Strong\'s.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:interlinear')
                .setLabel('Show')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Church Fathers on John 3:16**\n-# What did Augustine, Chrysostom, and others say about the Gospel in a verse?'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:fathers')
                .setLabel('Show')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Classic commentary on Romans 8:28**\n-# Adam Clarke\'s take. Switch commentators in the full /commentary view.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:commentary')
                .setLabel('Show')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Cross References on John 1:1**\n-# Treasury of Scripture Knowledge — 340k cross-refs total.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:crossrefs')
                .setLabel('Show')
                .setStyle(ButtonStyle.Primary)
            )
        )
        .addSectionComponents(new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                '**Help — see all commands**\n-# Full category browser across every feature.'
            ))
            .setButtonAccessory(new ButtonBuilder()
                .setCustomId('welcome:help')
                .setLabel('Browse')
                .setStyle(ButtonStyle.Primary)
            )
        );

    // Second container holds the admin-setting intro text blocks. Kept
    // separate from the demo container so the main container doesn't blow
    // past Discord's per-container child cap (~10) — we're already at 9
    // children there with 7 Section demos + header + intro.
    const settingsIntro = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### ⚙️ Passive detection',
                'When someone types a scripture reference in chat, what should I do?',
                '*Only server admins can change this. Default is safe coexistence with BibleBot.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### 🤖 AI chat',
                'When enabled, Biblicana responds to **@mentions** and **replies**',
                'with answers grounded in Scripture and classical commentary.',
                '*Default is OFF — opt in below.*',
            ].join('\n')
        ))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                '### 📅 Verse of the Day',
                'Auto-post the daily verse to this server\'s system channel at 13:00 UTC',
                '(morning in the US).',
                '*For a different channel or hour, use `/config daily` after enabling.*',
            ].join('\n')
        ));

    // Passive-mode select in its own ActionRow below the container.
    const passiveRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('welcome:passive')
            .setPlaceholder('Pick a passive-detection mode')
            .addOptions(PASSIVE_MODE_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === currentPassiveMode)
            ))
    );

    // AI on/off select — separate row since it's a separate decision.
    const aiCurrentValue = currentAiEnabled ? 'on' : 'off';
    const aiRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('welcome:ai')
            .setPlaceholder('Enable or disable AI chat')
            .addOptions(AI_OPTIONS.map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === aiCurrentValue)
            ))
    );

    // Daily verse on/off — enabling here defaults to system channel @ 13 UTC.
    // /config daily lets admins tune channel and hour further.
    const dailyCurrentValue = currentDailyEnabled ? 'on' : 'off';
    const dailyRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('welcome:daily')
            .setPlaceholder('Enable or disable Verse of the Day')
            .addOptions([
                {
                    value: 'on',
                    label: 'Verse of the Day: On',
                    description: 'Daily post to system channel at 13:00 UTC. Tune with /config daily.',
                },
                {
                    value: 'off',
                    label: 'Verse of the Day: Off (default)',
                    description: 'No auto-posting. /passageoftheday still works on demand.',
                },
            ].map(opt =>
                new StringSelectMenuOptionBuilder()
                    .setValue(opt.value)
                    .setLabel(opt.label)
                    .setDescription(opt.description)
                    .setDefault(opt.value === dailyCurrentValue)
            ))
    );

    // Footer card with help + support + legal links.
    const footer = new ContainerBuilder()
        .setAccentColor(accentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            [
                `📖 **Full command list**: \`/help\``,
                `🆘 **Support server**: ${SUPPORT_INVITE}`,
                `📜 [Privacy](${PRIVACY_URL}) · [Terms](${TERMS_URL})`,
                '',
                footerLine('Biblicana welcome card'),
            ].join('\n')
        ));

    return [container, settingsIntro, passiveRow, aiRow, dailyRow, footer];
}

export { PASSIVE_MODE_OPTIONS };
// Re-export SUPPORT_INVITE from here for backwards compatibility — other
// modules (aiConfig.js etc.) still import it from this file.
export { SUPPORT_INVITE } from './theme.js';
