/** Sends a direct message; people with DMs closed are normal, so a failure is swallowed and reported as false. */
export const tryDmSafe = (user, content) =>
  user
    .send(content)
    .then(() => true)
    .catch(() => false);
