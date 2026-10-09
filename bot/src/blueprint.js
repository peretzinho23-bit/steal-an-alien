// The whole server layout lives here as data: roles, categories, channels, permissions.
// Texts for the pinned messages live in ./content.js. Nothing in this file talks to Discord.

export const GAME_NAME = 'Steal an Alien';
export const SEP = '｜'; // full-width bar used between the emoji and the channel name

/** Roles from highest to lowest. Owner is never touched: an existing one is kept as-is. */
export const OWNER_ROLE_NAME = 'Owner';

export const ROLES = [
  { key: 'admin', name: 'Admin', color: 0xe74c3c, hoist: true, administrator: true },
  {
    key: 'mod',
    name: 'Moderator',
    color: 0xe67e22,
    hoist: true,
    perms: ['ManageMessages', 'KickMembers', 'ModerateMembers', 'MuteMembers', 'ManageNicknames', 'ViewAuditLog'],
  },
  { key: 'dev', name: 'Developer', color: 0x9b59b6, hoist: true },
  { key: 'tester', name: 'Tester', color: 0x2ecc71, hoist: true },
  { key: 'member', name: 'Member', color: 0x3498db, hoist: false },
];

/**
 * Rank roles of the level system. A member holds exactly one: the highest tier at or below their level.
 * They sit below the Member role, so staff colours always win in the member list.
 */
export const RANKS = [
  { level: 1, name: 'Lv.1 Recruit', color: 0x95a5a6 },
  { level: 5, name: 'Lv.5 Scout', color: 0x1abc9c },
  { level: 10, name: 'Lv.10 Abductor', color: 0x7cfc00 },
  { level: 20, name: 'Lv.20 Commander', color: 0x00bcd4 },
  { level: 30, name: 'Lv.30 Overlord', color: 0xe91e63 },
  { level: 50, name: 'Lv.50 Legend', color: 0xffd700 },
];

/** Role handed to every new member by the bot. */
export const MEMBER_ROLE_KEY = 'member';

/**
 * Permission presets, expressed as who can do what in a channel.
 *   read    -> everyone sees it, nobody but staff writes
 *   chat    -> everyone sees and writes
 *   staff   -> only the listed roles see it
 * Staff roles (admin, mod) can always write; `writers` adds extra roles (e.g. dev).
 */
export const STAFF = ['admin', 'mod'];

const ch = (key, emoji, name, extra = {}) => ({
  key,
  name: emoji ? `${emoji}${SEP}${name}` : name,
  type: 'text',
  access: 'chat',
  ...extra,
});

/**
 * Order matters. INFO first so new members land on the welcome/rules, then the chat areas
 * from the original layout (Text, Voice, GAME, SUPPORT) and a hidden STAFF area at the bottom.
 */
export const CATEGORIES = [
  {
    name: '📢 INFO',
    public: true, // stays visible to everyone even while the verification gate hides the rest
    channels: [
      ch('welcome', '👋', 'welcome', { access: 'read', topic: `Welcome to the official ${GAME_NAME} community!` }),
      ch('rules', '📜', 'rules', { access: 'read', topic: 'Read these before you chat.' }),
      ch('announcements', '📣', 'announcements', { access: 'read', topic: 'Big news about the game and the server.' }),
      ch('updates', '🚀', 'updates', { access: 'read', topic: 'Game updates and patch notes.' }),
    ],
  },
  {
    name: 'Text Channels',
    channels: [
      ch('general', null, 'general', { topic: 'Talk about anything related to the game.' }),
      ch('media', '📷', 'media', { topic: 'Screenshots, clips and fan art.' }),
      ch('suggestions', '💡', 'suggestions', { topic: 'One idea per message. The community votes with 👍 / 👎.' }),
      ch('bot-commands', '🤖', 'bot-commands', { topic: 'Use bot commands here to keep other channels clean.' }),
    ],
  },
  {
    name: 'Voice Channels',
    channels: [{ key: 'voice-general', name: 'General', type: 'voice', access: 'chat' }],
  },
  {
    name: '🎮 GAME',
    channels: [
      ch('bug-reports', '🐛', 'bug-reports', { topic: 'Found a bug? Report it using the pinned template.' }),
      ch('dev-sneak-peeks', '🛠', 'dev-sneak-peeks', {
        access: 'read',
        writers: ['dev'],
        topic: 'Early looks at what the developers are building.',
      }),
      ch('testers-chat', '🧪', 'testers-chat', {
        access: 'staff',
        viewers: ['tester', 'dev'],
        topic: 'Private chat for testers and developers.',
      }),
    ],
  },
  {
    name: '🎫 SUPPORT',
    isTicketCategory: true,
    channels: [
      ch('create-ticket', '🎫', 'create-ticket', {
        access: 'read',
        public: true,
        topic: 'Need help or want to report something privately? Press the button below.',
      }),
    ],
  },
  {
    name: '🔒 STAFF',
    staffOnly: true,
    channels: [
      ch('staff-chat', '💬', 'staff-chat', { access: 'staff', topic: 'Staff only.' }),
      ch('ticket-logs', '📋', 'ticket-logs', { access: 'staff', topic: 'Transcripts of closed tickets.' }),
      ch('mod-log', '📜', 'mod-log', {
        access: 'staff',
        topic: 'Automatic log: moderation actions, AutoMod alerts, joins, leaves and deleted messages.',
      }),
    ],
  },
];

export const allChannels = () => CATEGORIES.flatMap((c) => c.channels);

/** The part of a channel name after the emoji prefix, lower-cased, spaces as dashes: "👋｜welcome" -> "welcome". */
export const channelKey = (name) => name.split(SEP).pop().trim().toLowerCase().replace(/\s+/g, '-');

/** Blueprint channels as { spec, category } pairs, handy for "which ones are missing". */
export const blueprintEntries = () => CATEGORIES.flatMap((category) => category.channels.map((spec) => ({ spec, category })));

/** Channel names that exist in the original server screenshot. Used by the tests as a checklist. */
export const ORIGINAL_CHANNEL_NAMES = [
  'general',
  `📷${SEP}media`,
  `💡${SEP}suggestions`,
  `🤖${SEP}bot-commands`,
  'General',
  `👋${SEP}welcome`,
  `📜${SEP}rules`,
  `📣${SEP}announcements`,
  `🚀${SEP}updates`,
  `🐛${SEP}bug-reports`,
  `🛠${SEP}dev-sneak-peeks`,
  `🧪${SEP}testers-chat`,
  `🎫${SEP}create-ticket`,
];
