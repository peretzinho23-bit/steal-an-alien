import { IDS } from './content.js';
import { verifyMember } from './gate.js';
import { handleTicketButton } from './tickets.js';

/** Routes every button press by its customId. */
export function handleButton(interaction) {
  if (interaction.customId === IDS.verify) return verifyMember(interaction);
  if (interaction.customId.startsWith('ticket:')) return handleTicketButton(interaction);
  return null;
}
