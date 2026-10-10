import { register } from '../lib/i18n.js';

// the Discord-style preview (lib/preview.js and lib/markdown.js)
register('preview', {
  he: {
    today: 'היום',
    placeholder: 'כאן תראה איך ההודעה תיראה בדיסקורד...',
    label: 'תצוגה מקדימה של ההודעה בדיסקורד',
    'mention.role': 'תפקיד',
    'mention.channel': 'ערוץ',
    'mention.member': 'משתמש',
  },
  en: {
    today: 'Today',
    placeholder: 'Here you will see how the message looks in Discord...',
    label: 'Preview of the message in Discord',
    'mention.role': 'role',
    'mention.channel': 'channel',
    'mention.member': 'member',
  },
});
