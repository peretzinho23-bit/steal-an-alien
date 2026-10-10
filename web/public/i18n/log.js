import { register } from '../lib/i18n.js';

// the activity log screen
register('log', {
  he: {
    title: 'יומן פעילות',
    sub: 'כל מה שהצוות והבוט עשו: הכרזות, אזהרות, השתקות, שינויי הגדרות ועוד. מוצגות {count} הפעולות האחרונות.',
    source: 'מקור',
    all: 'הכל',
    web: 'האתר',
    bot: 'הבוט',
    searchPlaceholder: 'חפש בפעולות',
    searchAria: 'חיפוש ביומן',
    noResults: 'אין תוצאות',
    noResultsText: 'נסה מסנן או חיפוש אחר.',
    emptyText: 'עוד לא נרשמה פעילות. היומן צריך את האחסון המשותף (Redis) כדי לעבוד.',
  },
  en: {
    title: 'Activity log',
    sub: 'Everything the staff and the bot have done: announcements, warnings, timeouts, setting changes and more. The latest {count} actions are shown.',
    source: 'Source',
    all: 'All',
    web: 'Website',
    bot: 'Bot',
    searchPlaceholder: 'Search actions',
    searchAria: 'Search the log',
    noResults: 'No results',
    noResultsText: 'Try another filter or search.',
    emptyText: 'No activity has been logged yet. The log needs the shared storage (Redis) to work.',
  },
});
