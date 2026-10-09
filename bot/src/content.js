import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { GAME_NAME } from './blueprint.js';
import { mention } from './util.js';

export const COLOR = 0x57f287; // alien green
export const IDS = { ticketOpen: 'ticket:open', ticketClose: 'ticket:close' };

const base = () => new EmbedBuilder().setColor(COLOR).setFooter({ text: `${GAME_NAME} • Official Community` });

export function welcomePanel(guild) {
  const m = (key) => mention(guild, key);
  return {
    embeds: [
      base()
        .setTitle(`👽 Welcome to ${GAME_NAME}!`)
        .setDescription(
          `This is the official community server for **${GAME_NAME}** on Roblox.\n` +
            'Hang out, share your best steals, report bugs and help shape the game.',
        )
        .addFields(
          { name: '1️⃣ Read the rules', value: `${m('rules')}`, inline: true },
          { name: '2️⃣ Catch the news', value: `${m('announcements')}\n${m('updates')}`, inline: true },
          { name: '3️⃣ Say hi', value: `${m('general')}`, inline: true },
          { name: '🐛 Found a bug?', value: `${m('bug-reports')}`, inline: true },
          { name: '💡 Got an idea?', value: `${m('suggestions')}`, inline: true },
          { name: '🎫 Need help?', value: `${m('create-ticket')}`, inline: true },
        ),
    ],
  };
}

export function rulesPanel() {
  const rules = [
    '**Be respectful.** No insults, harassment, hate speech or discrimination of any kind.',
    '**Keep it clean.** No NSFW, gore or shocking content, anywhere.',
    '**No spam.** No flooding, mass pings, advertising or Discord invite links.',
    '**No scams.** Never share your Roblox password or cookie. Staff will never ask for them. Trade only inside the game.',
    '**No exploits or cheats.** Do not share, sell or promote them. Found an exploit? Report it privately with a ticket.',
    '**Use the right channel.** Bugs in bug-reports, ideas in suggestions, bot commands in bot-commands.',
    '**Follow the Terms.** Discord and Roblox Terms of Service apply here.',
    '**Staff have the final word.** Disagree with a decision? Open a ticket, do not argue in chat.',
  ];
  return {
    embeds: [
      base()
        .setTitle('📜 Server Rules')
        .setDescription(rules.map((r, i) => `**${i + 1}.** ${r}`).join('\n\n'))
        .addFields({ name: 'Breaking the rules', value: 'Warning → timeout → kick → ban, depending on how serious it is.' }),
    ],
  };
}

export function openingAnnouncement() {
  return {
    embeds: [
      base()
        .setTitle('🎉 The server is open!')
        .setDescription(
          `Welcome to the new **${GAME_NAME}** community. Game news will be posted here. ` +
            'Turn on notifications for this channel so you never miss an update.',
        ),
    ],
  };
}

export function updatesPanel() {
  return {
    embeds: [
      base()
        .setTitle('🚀 Game Updates')
        .setDescription('Every update and patch note for the game is posted in this channel, newest at the bottom.'),
    ],
  };
}

export function bugTemplate() {
  return {
    embeds: [
      base()
        .setTitle('🐛 How to report a bug')
        .setDescription('Copy the template, fill it in and post it. Clear reports get fixed faster.')
        .addFields(
          {
            name: 'Template',
            value:
              '```\nWhat happened:\nWhat you expected:\nSteps to reproduce:\n1.\n2.\n3.\nDevice (PC / phone / console):\nScreenshot or video:\n```',
          },
          { name: 'Security issues', value: 'Exploits and cheats go through a ticket, not here.' },
        ),
    ],
  };
}

export function suggestionsGuide() {
  return {
    embeds: [
      base()
        .setTitle('💡 Suggestions')
        .setDescription(
          'Post **one idea per message** and explain why it would make the game better.\n' +
            'The bot adds 👍 and 👎 so everyone can vote. Check that your idea was not already posted.',
        ),
    ],
  };
}

/**
 * Embed fields for a command list, grouped by category. A field holds at most 1024 characters,
 * so a long category continues in a second field instead of being cut off.
 * `commands` is [{ name, description, category }].
 */
export function commandFields(commands) {
  const groups = new Map();
  for (const c of commands) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(`\`/${c.name}\` ${c.description}`.slice(0, 200));
  }
  const fields = [];
  for (const [category, lines] of groups) {
    let chunk = [];
    let length = 0;
    let part = 1;
    const flush = () => {
      if (!chunk.length) return;
      fields.push({ name: part === 1 ? category : `${category} (${part})`, value: chunk.join('\n') });
      chunk = [];
      length = 0;
      part++;
    };
    for (const line of lines) {
      if (length + line.length + 1 > 1024) flush();
      chunk.push(line);
      length += line.length + 1;
    }
    flush();
  }
  return fields;
}

/** The guide is generated from the real command list so it can never go stale. */
export function botCommandsGuide(commands) {
  const embed = base().setTitle('🤖 Bot commands').setDescription('Use these in this channel to keep the others clean.');
  embed.addFields(commandFields(commands).slice(0, 25));
  return { embeds: [embed] };
}

export function ticketPanel() {
  return {
    embeds: [
      base()
        .setTitle('🎫 Support')
        .setDescription(
          'Need help, want to report a player, an exploit or something private?\n' +
            'Press the button and a private channel opens just for you and the staff.',
        ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.ticketOpen).setLabel('Open a ticket').setEmoji('🎫').setStyle(ButtonStyle.Success),
      ),
    ],
  };
}

export function ticketWelcome(user) {
  return {
    content: `${user}`,
    embeds: [
      base()
        .setTitle('🎫 Ticket opened')
        .setDescription('Describe what you need and a staff member will answer here soon.\nPress the button when you are done.'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(IDS.ticketClose).setLabel('Close ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

export function memberWelcome(member) {
  const { guild } = member;
  return {
    content: `${member}`,
    embeds: [
      base()
        .setTitle(`👽 Welcome, ${member.displayName}!`)
        .setDescription(
          `You are member **#${guild.memberCount}** of the ${GAME_NAME} community.\n` +
            `Start with ${mention(guild, 'rules')}, then say hi in ${mention(guild, 'general')}.`,
        )
        .setThumbnail(member.displayAvatarURL()),
    ],
    allowedMentions: { users: [member.id] },
  };
}
