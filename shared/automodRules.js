/**
 * Builds Discord native AutoMod rules from the dashboard settings and keeps them in sync.
 * Used by the bot (on start and when settings change) and by the website (when settings are saved),
 * so both sides always produce exactly the same rules. Rules we own are named "SAA - ...".
 */

export const RULE_PREFIX = 'SAA - ';

const TRIGGER = { KEYWORD: 1, SPAM: 3, KEYWORD_PRESET: 4, MENTION_SPAM: 5 };
const ACTION = { BLOCK: 1, ALERT: 2, TIMEOUT: 3 };
const PRESET_IDS = { profanity: 1, sexual: 2, slurs: 3 };

// Rust regex flavour (Discord's engine): no lookaround, no backreferences. Each pattern must be <= 260 chars.
export const INVITE_PATTERNS = [String.raw`(?i)(discord\.gg|discord(app)?\.com/invite|dsc\.gg|invite\.gg)/[a-z0-9-]+`];
export const SCAM_PATTERNS = [
  String.raw`(?i)free\s*robux`,
  String.raw`(?i)robux\s*(generator|giveaway|hack|gift|code)`,
  String.raw`(?i)(claim|get)\s.{0,20}free\s*(robux|rbx|limiteds?|nitro)`,
  String.raw`(?i)free\s*nitro`,
  String.raw`(?i)(bit\.ly|tinyurl\.com|cutt\.ly|rb\.gy|is\.gd)/\S+`,
  String.raw`(?i)steamcommunity\.com/gift`,
];

const rule = (name, triggerType, triggerMetadata, actions, exemptRoleIds) => ({
  name: `${RULE_PREFIX}${name}`,
  event_type: 1,
  trigger_type: triggerType,
  trigger_metadata: triggerMetadata,
  actions,
  enabled: true,
  exempt_roles: exemptRoleIds.slice(0, 20),
  exempt_channels: [],
});

/** @returns the list of rules that should exist (empty when AutoMod is off). */
export function buildRules(settings, { alertChannelId = null, exemptRoleIds = [] } = {}) {
  const a = settings.automod;
  if (!a.enabled) return [];
  const block = { type: ACTION.BLOCK, metadata: { custom_message: a.blockMessage } };
  const alert = alertChannelId ? { type: ACTION.ALERT, metadata: { channel_id: alertChannelId } } : null;
  const base = [block, alert].filter(Boolean);
  const rules = [];

  if (a.spam) rules.push(rule('Spam', TRIGGER.SPAM, {}, base, exemptRoleIds));

  if (a.mentions.enabled) {
    const actions = [...base];
    if (a.mentions.timeoutMinutes > 0) {
      actions.push({ type: ACTION.TIMEOUT, metadata: { duration_seconds: a.mentions.timeoutMinutes * 60 } });
    }
    rules.push(
      rule('Mention spam', TRIGGER.MENTION_SPAM, {
        mention_total_limit: a.mentions.limit,
        mention_raid_protection_enabled: a.mentions.raidProtection,
      }, actions, exemptRoleIds),
    );
  }

  if (a.badWords.enabled && a.badWords.presets.length) {
    rules.push(
      rule('Bad words', TRIGGER.KEYWORD_PRESET, {
        presets: a.badWords.presets.map((p) => PRESET_IDS[p]),
        allow_list: a.badWords.allow,
      }, base, exemptRoleIds),
    );
  }

  if (a.customWords.enabled && a.customWords.words.length) {
    rules.push(rule('Custom words', TRIGGER.KEYWORD, { keyword_filter: a.customWords.words }, base, exemptRoleIds));
  }
  if (a.invites.block) rules.push(rule('Invites', TRIGGER.KEYWORD, { regex_patterns: INVITE_PATTERNS }, base, exemptRoleIds));
  if (a.scams.block) rules.push(rule('Scams', TRIGGER.KEYWORD, { regex_patterns: SCAM_PATTERNS }, base, exemptRoleIds));
  return rules;
}

/** What to create, update and delete so that our rules equal `desired`. Other people's rules are never touched. */
export function diffRules(existing, desired) {
  const own = existing.filter((r) => r.name?.startsWith(RULE_PREFIX));
  const byName = new Map(own.map((r) => [r.name, r]));
  const wanted = new Set(desired.map((r) => r.name));
  const create = [];
  const update = [];
  for (const rule of desired) {
    const current = byName.get(rule.name);
    if (!current) create.push(rule);
    else {
      const { trigger_type: _ignored, ...patch } = rule; // the trigger type cannot be changed after creation
      update.push({ id: current.id, patch });
    }
  }
  const remove = own.filter((r) => !wanted.has(r.name)).map((r) => ({ id: r.id, name: r.name }));
  return { create, update, remove };
}

/**
 * Applies the diff through `rest(method, path, body)` (any function returning parsed JSON).
 * One failing rule does not stop the others; failures are returned.
 */
export async function syncAutoModRules(rest, guildId, desired) {
  const base = `/guilds/${guildId}/auto-moderation/rules`;
  const existing = await rest('GET', base);
  const { create, update, remove } = diffRules(existing, desired);
  const summary = { created: [], updated: [], removed: [], errors: [] };
  const attempt = async (label, bucket, fn) => {
    try {
      await fn();
      summary[bucket].push(label);
    } catch (e) {
      summary.errors.push(`${label}: ${e.message}`);
    }
  };
  for (const r of create) await attempt(r.name, 'created', () => rest('POST', base, r));
  for (const u of update) await attempt(u.patch.name, 'updated', () => rest('PATCH', `${base}/${u.id}`, u.patch));
  for (const d of remove) await attempt(d.name, 'removed', () => rest('DELETE', `${base}/${d.id}`));
  return summary;
}
