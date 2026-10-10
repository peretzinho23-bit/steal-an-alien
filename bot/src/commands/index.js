import channels from './channels.js';
import general, { makeHelp } from './general.js';
import levels from './levels.js';
import moderation from './moderation.js';
import roles from './roles.js';
import rooms from './rooms.js';
import staff from './staff.js';
import voice from './voice.js';
import warns from './warns.js';

/** Every command is { category, data: SlashCommandBuilder, run(interaction) }. */
export const commands = [...general, ...levels, ...moderation, ...warns, ...channels, ...roles, ...voice, ...rooms, ...staff];
commands.push(makeHelp(() => commands));

const byName = new Map(commands.map((c) => [c.data.name, c]));

export const commandData = commands.map((c) => c.data.toJSON());
export const handleCommand = (interaction) => byName.get(interaction.commandName)?.run(interaction);
export const registerCommands = (guild) => guild.commands.set(commandData);

/** Plain list for texts (the pinned guide in #bot-commands). */
export const describeCommands = () =>
  commands.map((c) => ({ name: c.data.name, description: c.data.description, category: c.category }));
