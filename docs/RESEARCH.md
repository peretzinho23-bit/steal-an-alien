# מחקר: אוטו-אדמין ופקודות צוות

## AutoMod המובנה של Discord (התיעוד הרשמי, נבדק)
- כללים לכל שרת: מילים (KEYWORD) עד **6**, ספאם (SPAM) **1**, רשימות מוכנות (KEYWORD_PRESET) **1**, אזכורים (MENTION_SPAM) **1**, פרופיל משתמש **1**.
- מילים: עד 1000 לכלל, עד 60 תווים כל אחת. Regex: עד 10 לכלל, עד 260 תווים (תחביר Rust, בלי backreference). רשימת חריגים: עד 100.
- פעולות: חסימת הודעה (עם הסבר עד 150 תווים), התראה לערוץ, Timeout (רק לכללי מילים ואזכורים, עד 4 שבועות, דורש גם Moderate Members), חסימת אינטראקציה.
- יצירת כלל דורשת Manage Guild. עד 20 רולים ו-50 ערוצים פטורים.
- **למה זה חשוב:** רץ אצל Discord, גם כשהבוט כבוי, ובלי הרשאת MessageContent. לכן זה הבסיס, והבוט משלים רק מה שחסר.

## הגנה מפני פשיטות (Discord + מדריכי קהילה)
- רמת אימות: Medium (חשבון בן 5 דקות) כברירת מחדל, High (10 דקות בשרת) בזמן פשיטה.
- שער אימות (כפתור אחרי קריאת החוקים) לפני שמקבלים גישה לערוצים — ההמלצה הנפוצה ביותר.
- גיל חשבון מינימלי (המלצה נפוצה: 7 ימים; אצלנו ברירת מחדל 3 ימים, ניתן לשינוי).
- נעילה בזמן פשיטה: השבתת הזמנות (`PUT /guilds/{id}/incident-actions`, עד 24 שעות, דורש Manage Guild) + מניעת כתיבה ל-@everyone בערוצים הציבוריים. הודעה אחת קצרה לחברים.
- להסיר מ-@everyone הרשאת אזכור @everyone (כבר נעשה בסבב 1).

## פקודות צוות נפוצות (Dyno / Carl-bot / MEE6)
Dyno חזק במודרציה ולוגים, Carl-bot ברולים ולוגים, MEE6 בדרגות ותוספות. מה שמשותף ונכנס אלינו:
אזהרות עם הסלמה אוטומטית, mute/timeout, kick/ban/tempban, purge, slowmode, lock/unlock/lockdown, ניהול רולים וכינויים, תפריט רולים עצמי, חדרי קול זמניים (join-to-create), לוג מרכזי של כל פעולה.

## החלטות
1. AutoMod מובנה כבסיס, וכללי הבוט רק לפער (פשיטות, אימות, כפילויות, CAPS, הסלמת אזהרות).
2. כללי AutoMod נשלטים משני מקומות (הבוט והאתר) דרך קוד משותף אחד שבונה את הכללים, כדי שלא יתנגשו.
3. הכל מתחיל כבוי-בטוח: אין ברירת מחדל שמוחקת או מעניקה עונש כבד (אזהרות מסלימות רק ל-Timeout בשלב ראשון).
4. לא מכפילים את Bloxlink (קישור חשבון Roblox), Arcane (דרגות חיצוניות) או Ticket Tool — הבוט שלנו עושה דרגות וטיקטים לבד.

מקורות: [Discord AutoMod docs](https://docs.discord.com/developers/resources/auto-moderation), [Discord Guild docs (incident actions)](https://docs.discord.com/developers/resources/guild), [Discord: Raids 101](https://support.discord.com/hc/en-us/articles/10989121220631-How-to-Protect-Your-Server-from-Raids-101), [Discord AutoMod overview](https://discord.com/safety/auto-moderation-in-discord).
המקורות של חברות בוטים (PeakBot, RestoreCord) משמשים רק כהמלצות ולא כעובדות.
