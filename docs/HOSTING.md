# מדריך התקנה

שלושה דברים צריך להעלות, בסדר הזה. הכל חינם.

```
   Discord  <----->  הבוט (Kerit)  <----- Upstash Redis ----->  האתר (Vercel)
```

**Upstash Redis** הוא "הזיכרון המשותף" של הבוט והאתר: דרכו האתר שומר הגדרות ואזהרות ויומן, ושולח לבוט פקודות כמו נעילת חירום. בלי הוא, הכרזות והודעות וניהול ערוצים עדיין עובדים, אבל שאר האתר מוגבל.

---

## שלב 1. Upstash Redis (3 דקות)

1. נכנסים ל-https://upstash.com ופותחים חשבון חינם.
2. **Create Database** ← שם כלשהו ← אזור קרוב (למשל `eu-west-1`) ← Create.
3. בעמוד של ה-Database, בלשונית **REST API**, מעתיקים שני ערכים:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

שומרים אותם בצד. הם נכנסים גם לבוט וגם לאתר, **אותם ערכים בדיוק**.

## שלב 2. פורטל המפתחים של Discord

ב-https://discord.com/developers/applications ← האפליקציה **Steal An Alien**:

1. **Bot** ← Privileged Gateway Intents: מפעילים **Server Members Intent** ו-**Message Content Intent** ← Save.
   (בלי Message Content, ההגנות מפני הודעות חוזרות, אותיות גדולות וקישורים כבויות. השאר עובד.)
2. **OAuth2** ← מעתיקים את ה-**Client ID**, ולוחצים **Reset Secret** ומעתיקים את ה-**Client Secret** (מוצג פעם אחת).
3. את ה-Redirect מוסיפים בשלב 4, אחרי שיש כתובת לאתר.

## שלב 3. הבוט (Kerit או כל אירוח לבוטים)

1. פותחים את `bot/.env` ומוודאים שיש בו (הטוקן והשרת כבר שם):
   ```
   DISCORD_TOKEN=...
   GUILD_ID=...
   UPSTASH_REDIS_REST_URL=...        <- מהשלב 1
   UPSTASH_REDIS_REST_TOKEN=...      <- מהשלב 1
   ```
2. בתיקיית `bot/` מריצים `npm run pack`. נוצר `bot/dist/steal-an-alien-bot.zip` (**הקובץ מכיל את הטוקן, לא לשתף**).
3. באירוח: Files ← מוחקים את הקבצים הישנים (חוץ מהתיקייה `data` אם יש, שם ה-XP) ← Upload ל-zip ← Unarchive.
4. בלשונית Startup: הקובץ הראשי נשאר `index.js`. מוחקים את `node_modules` אם הוא נשאר מהפעם הקודמת. Console ← **Start**.
5. בקונסולה צריך להופיע `Settings store: Upstash Redis (shared with the website)` ואחריה `Logged in as Steal An Alien`.

הבוט משתמש ב-Node 18 ומעלה. אם האירוח מציע גרסה חדשה יותר, עדיף אותה.

## שלב 4. האתר (Vercel)

הדרך הקלה: דרך GitHub.

1. ב-https://vercel.com נכנסים עם GitHub ולוחצים **Add New → Project** ובוחרים את `steal-an-alien`.
2. **Root Directory: `web`** (חשוב!). Framework Preset: Other. בלי Build Command.
3. פותחים **Environment Variables** ומוסיפים:

| שם | ערך |
|---|---|
| `GUILD_ID` | מזהה השרת |
| `DISCORD_BOT_TOKEN` | הטוקן של הבוט |
| `DISCORD_CLIENT_ID` | מהשלב 2 |
| `DISCORD_CLIENT_SECRET` | מהשלב 2 |
| `SESSION_SECRET` | טקסט אקראי ארוך (ליצור: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`) |
| `UPSTASH_REDIS_REST_URL` | מהשלב 1 |
| `UPSTASH_REDIS_REST_TOKEN` | מהשלב 1 |

4. **Deploy**. בסוף מקבלים כתובת כמו `https://steal-an-alien-xxxx.vercel.app`.
5. חוזרים לפורטל המפתחים ← **OAuth2 ← Redirects ← Add Redirect** ← מדביקים:
   `https://<הכתובת שלך>/api/auth/callback` ← Save Changes.

בלי GitHub: בתיקיית `web/` מריצים `npx vercel` (פעם ראשונה מתחברים בדפדפן), עונים על השאלות, ואז `npx vercel --prod`. את המשתנים מוסיפים בדשבורד של Vercel ← Settings ← Environment Variables ואז מפעילים Deploy מחדש.

## שלב 5. בדיקה ראשונה

1. פותחים את הכתובת ולוחצים **התחבר עם Discord**. אם כתוב "החשבון לא מוגדר כצוות", צריך שיהיה לך הרול Moderator או Admin בשרת.
2. בסקירה צריך להופיע **הבוט: מחובר** (תוך כמה דקות מהפעלת הבוט).
3. נכנסים ל-**אוטו-אדמין** ולוחצים **שמור והחל**: זה יוצר את כללי ה-AutoMod ב-Discord.
4. כותבים הכרזה לערוץ `staff-chat` כבדיקה.

## אבטחה

- מי נכנס: רק מי שיש לו בשרת רול `Moderator` או `Admin` (או הרשאת Administrator, או Manage Messages). ההרשאה נבדקת מחדש כל 10 דקות: מי שהורידו לו את הרול מאבד גישה.
- **אדמין** יכול הכל. **צוות** יכול: הכרזות, הודעות, חברים, נעילת חירום. הגדרות, ערוצים ורולים הם לאדמינים בלבד.
- לא לתייג `@everyone` מהאתר אלא אדמין, ורק אחרי אישור.
- הטוקן של הבוט מופיע בשלושה מקומות: `bot/.env`, הזיפ של הבוט, והמשתנים של Vercel. **אחרי שהכל עובד כדאי לאפס אותו** (פורטל ← Bot ← Reset Token) ולעדכן בשלושתם.
- אף פעם לא מגדירים ב-Vercel את `ALLOW_DEV_LOGIN` או `KV_FILE`. הם לבדיקות מקומיות בלבד, והאתר מתעלם מהם ב-Vercel.

## תקלות נפוצות

| מה רואים | מה לעשות |
|---|---|
| "Discord לא אישר את ההתחברות" | ה-Redirect לא נוסף או לא תואם לכתובת של האתר (שלב 4, סעיף 5) |
| "האתר עוד לא מוגדר" | חסר אחד המשתנים בטבלה. ההודעה אומרת איזה |
| הבוט מופיע "לא מגיב" | הבוט כבוי, או שהוא ואתר לא מחוברים לאותו Redis |
| "Discord refused this: Missing Permissions" | הרול של הבוט צריך להיות גבוה מהרול שמנסים לשנות |
| הגדרות נשמרו "עם בעיות" | Discord מגביל את מספר כללי ה-AutoMod. הבוט ינסה שוב לבד |
| אין רולי דרגות / ערוצים חדשים | הבוט יוצר אותם לבד בהפעלה. בדוק שהרול שלו גבוה מספיק |

## הרצה על שרת משלך במקום Vercel

בתיקיית `web/` יוצרים `.env.local` לפי `.env.example` ומריצים `npm start`. האתר רץ על הפורט 3000 (`PORT` משנה). צריך כתובת HTTPS כדי שההתחברות עם Discord תעבוד מחוץ ל-localhost.
