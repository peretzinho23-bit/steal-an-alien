import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Collection, PermissionFlagsBits as P } from 'discord.js';
import { closeTicket, isTicketChannel, openTicket, ticketOwnerId } from '../src/tickets.js';

const BOT_ID = 'bot-1';

/** A fake guild with the channels/roles the ticket code looks up. */
function fakeGuild() {
  const channels = new Collection();
  const created = [];
  const guild = {
    id: 'guild-1',
    channels: {
      cache: channels,
      create: async (options) => {
        const channel = {
          id: `ticket-${created.length + 1}`,
          name: options.name,
          topic: options.topic,
          parent: { id: options.parent },
          sent: [],
          send: async (p) => { channel.sent.push(p); },
          delete: async () => { channels.delete(channel.id); channel.deleted = true; },
          messages: { fetch: async () => new Collection() },
          toString: () => `<#${channel.id}>`,
        };
        created.push({ channel, options });
        channels.set(channel.id, channel);
        return channel;
      },
    },
    roles: {
      cache: new Collection([
        ['r-admin', { id: 'r-admin', name: 'Admin' }],
        ['r-mod', { id: 'r-mod', name: 'Moderator' }],
      ]),
    },
  };
  channels.set('panel', { id: 'panel', name: '🎫｜create-ticket', parent: { id: 'cat-support' } });
  const logs = { id: 'logs', name: '📋｜ticket-logs', sent: [], send: async (p) => { logs.sent.push(p); } };
  channels.set('logs', logs);
  return { guild, created, logs, channels };
}

function fakeInteraction(guild, user, extra = {}) {
  const replies = [];
  return {
    guild,
    user,
    member: { id: user.id, user, permissions: { has: () => false }, ...extra.member },
    channel: extra.channel,
    client: { user: { id: BOT_ID } },
    replies,
    deferReply: async () => replies.push({ deferred: true }),
    editReply: async (r) => replies.push({ edit: r }),
    reply: async (r) => replies.push({ reply: r }),
  };
}

const alice = { id: 'u-alice', username: 'Alice', tag: 'Alice#0001' };

test('openTicket: private channel under SUPPORT with the right overwrites', async () => {
  const { guild, created } = fakeGuild();
  const i = fakeInteraction(guild, alice);
  await openTicket(i);

  assert.equal(created.length, 1);
  const { channel, options } = created[0];
  assert.equal(options.name, 'ticket-alice');
  assert.equal(options.parent, 'cat-support', 'goes under the SUPPORT category');
  assert.equal(options.topic, 'ticket:u-alice');

  const ow = (id) => options.permissionOverwrites.find((o) => o.id === id);
  assert.ok(ow('guild-1').deny.includes(P.ViewChannel), '@everyone cannot see it');
  assert.ok(ow('u-alice').allow.includes(P.ViewChannel) && ow('u-alice').allow.includes(P.SendMessages));
  assert.ok(ow('r-admin').allow.includes(P.ViewChannel) && ow('r-mod').allow.includes(P.ViewChannel));
  assert.ok(ow(BOT_ID).allow.includes(P.ViewChannel));
  const ids = options.permissionOverwrites.map((o) => o.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate overwrite ids are rejected by Discord');

  assert.equal(channel.sent.length, 1, 'welcome message with the close button');
  assert.equal(channel.sent[0].components[0].components[0].data.custom_id, 'ticket:close');
  assert.match(i.replies.at(-1).edit, /ready/);
});

test('openTicket: a second ticket from the same person is refused and points to the first', async () => {
  const { guild, created } = fakeGuild();
  await openTicket(fakeInteraction(guild, alice));
  const again = fakeInteraction(guild, alice);
  await openTicket(again);
  assert.equal(created.length, 1, 'no second channel');
  assert.match(again.replies.at(-1).edit, /already have an open ticket/);
});

test('openTicket: two different people get two tickets', async () => {
  const { guild, created } = fakeGuild();
  await openTicket(fakeInteraction(guild, alice));
  await openTicket(fakeInteraction(guild, { id: 'u-bob', username: 'bob', tag: 'bob#0002' }));
  assert.equal(created.length, 2);
});

test('openTicket: awkward usernames still make a valid channel name', async () => {
  const names = [];
  for (const [username, expected] of [['Ñandú_99!', 'ticket-and99'], ['!!!', 'ticket-u-x'], ['A'.repeat(50), `ticket-${'a'.repeat(20)}`]]) {
    const { guild, created } = fakeGuild();
    await openTicket(fakeInteraction(guild, { id: 'u-x', username, tag: `${username}#1` }));
    names.push(created[0].options.name);
    assert.equal(created[0].options.name, expected);
  }
});

test('ticket helpers read the owner from the topic', () => {
  assert.equal(ticketOwnerId({ topic: 'ticket:123' }), '123');
  assert.equal(ticketOwnerId({ topic: 'Talk about anything' }), null);
  assert.equal(ticketOwnerId({ topic: null }), null);
  assert.ok(isTicketChannel({ topic: 'ticket:1' }));
  assert.ok(!isTicketChannel({ topic: undefined }));
});

async function openedTicket() {
  const env = fakeGuild();
  await openTicket(fakeInteraction(env.guild, alice));
  return { ...env, ticket: env.created[0].channel };
}

test('closeTicket: refuses a channel that is not a ticket', async () => {
  const { guild } = fakeGuild();
  const i = fakeInteraction(guild, alice, { channel: { id: 'x', topic: 'just a channel' } });
  await closeTicket(i, { delayMs: 0 });
  assert.match(i.replies.at(-1).reply.content, /not a ticket/);
});

test('closeTicket: a stranger without staff permissions cannot close it', async () => {
  const { guild, ticket } = await openedTicket();
  const i = fakeInteraction(guild, { id: 'u-eve', username: 'eve', tag: 'eve#3' }, { channel: ticket });
  await closeTicket(i, { delayMs: 0 });
  assert.match(i.replies.at(-1).reply.content, /Only the ticket owner or staff/);
  assert.ok(!ticket.deleted);
});

test('closeTicket: the owner closes it, transcript goes to #ticket-logs, channel is deleted', async () => {
  const { guild, ticket, logs } = await openedTicket();
  ticket.messages.fetch = async () =>
    new Collection([
      ['2', { createdAt: new Date('2026-01-01T10:01:00Z'), author: { tag: 'Mod#1' }, content: 'How can I help?' }],
      ['1', { createdAt: new Date('2026-01-01T10:00:00Z'), author: { tag: 'Alice#0001' }, content: 'My game crashes' }],
    ]);
  const i = fakeInteraction(guild, alice, { channel: ticket });
  await closeTicket(i, { delayMs: 0 });

  assert.ok(ticket.deleted, 'channel deleted');
  assert.equal(logs.sent.length, 1);
  const file = logs.sent[0].files[0];
  assert.equal(file.name, 'ticket-alice.txt');
  assert.match(logs.sent[0].content, /closed by/);
  assert.match(logs.sent[0].content, /2 messages/);
  const text = file.attachment.toString('utf8');
  assert.match(text, /Alice#0001: My game crashes/);
  assert.ok(text.indexOf('My game crashes') < text.indexOf('How can I help'), 'oldest message first');
});

test('closeTicket: staff (Manage Messages) can close someone else\'s ticket', async () => {
  const { guild, ticket } = await openedTicket();
  const i = fakeInteraction(guild, { id: 'u-mod', username: 'mod', tag: 'mod#4' }, {
    channel: ticket,
    member: { permissions: { has: (p) => p === P.ManageMessages } },
  });
  await closeTicket(i, { delayMs: 0 });
  assert.ok(ticket.deleted);
});

test('closeTicket: still closes if #ticket-logs is missing', async () => {
  const { guild, ticket, channels } = await openedTicket();
  channels.delete('logs');
  const i = fakeInteraction(guild, alice, { channel: ticket });
  await closeTicket(i, { delayMs: 0 });
  assert.ok(ticket.deleted);
});
