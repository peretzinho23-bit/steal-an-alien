import { register } from '../lib/i18n.js';

// the ranks (leaderboard) screen
register('ranks', {
  he: {
    title: 'דרגות',
    sub: 'הטבלה מתעדכנת מהבוט כל כמה דקות.',
    updated: 'הטבלה מתעדכנת מהבוט כל כמה דקות. עודכנה {when}.',
    emptyTitle: 'אין עדיין נתונים',
    emptyText: 'כשהחברים יתחילו לכתוב ולהיות בערוצי קול הם יצברו XP, והטבלה תופיע כאן. אם הבוט כבר רץ, חכה כמה דקות.',
    toNext: '{pct}% עד הרמה הבאה',
    level: 'רמה {level}',
    xp: '{xp} נקודות ניסיון',
    unnamed: 'מזהה {id}',
  },
  en: {
    title: 'Ranks',
    sub: 'The table is updated by the bot every few minutes.',
    updated: 'The table is updated by the bot every few minutes. Last updated {when}.',
    emptyTitle: 'No data yet',
    emptyText: 'When members start chatting and joining voice channels, they earn XP and the table shows up here. If the bot is already running, wait a few minutes.',
    toNext: '{pct}% to the next level',
    level: 'Level {level}',
    xp: '{xp} XP',
    unnamed: 'ID {id}',
  },
});
