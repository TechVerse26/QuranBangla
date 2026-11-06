// Runs on a schedule (GitHub Actions). For every subscribed device, checks
// whether a prayer time for its lat/lon just passed, and sends a push via
// Firebase Cloud Messaging if so. No Blaze plan needed — Firestore reads/writes
// and FCM sends via the Admin SDK are both free.
//
// Firestore writes only happen when a notification is actually sent (max 5
// writes per device per day, one per prayer) to stay well inside the free
// 20,000 writes/day quota even with many subscribers.
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const PRAYERS = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const LABELS_BN = { Fajr: 'ফজর', Dhuhr: 'যোহর', Asr: 'আসর', Maghrib: 'মাগরিব', Isha: 'ইশা' };
const WINDOW_MIN = 10; // must be >= the cron interval in the workflow file

function todayStr(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function nowHM(tz) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}
function minutesSince(hhmmThen, hhmmNow) {
  const [h1, m1] = hhmmThen.split(':').map(Number);
  const [h2, m2] = hhmmNow.split(':').map(Number);
  return (h2 * 60 + m2) - (h1 * 60 + m1);
}

async function run() {
  const snap = await db.collection('push_subscriptions').get();
  console.log(`Checking ${snap.size} subscription(s)...`);

  for (const doc of snap.docs) {
    const sub = doc.data();
    if (!sub.token || typeof sub.lat !== 'number' || typeof sub.lon !== 'number') continue;

    try {
      const url = `https://api.aladhan.com/v1/timings?latitude=${sub.lat}&longitude=${sub.lon}&method=${sub.method || 1}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!json || !json.data) continue;

      const tz = json.data.meta.timezone;
      const today = todayStr(tz);
      const now = nowHM(tz);
      let sentToday = (sub.lastNotifiedDate === today) ? (sub.lastNotifiedPrayers || []) : [];
      const startCount = sentToday.length;
      let removed = false;

      for (const p of PRAYERS) {
        const raw = (json.data.timings[p] || '').split(' ')[0]; // "HH:MM"
        if (!raw) continue;
        const diff = minutesSince(raw, now);
        

console.log(`  ${p}: raw=${raw} now=${now} diff=${diff}`);
        
        
        if (diff >= 0 && diff <= WINDOW_MIN && !sentToday.includes(p)) {
          try {
            await admin.messaging().send({
              token: sub.token,
              notification: {
                title: `${LABELS_BN[p]} এর সময় হয়েছে`,
                body: 'নামাজের জন্য প্রস্তুত হোন।'
              },
              // screen / category: read by the Android app (app/js/notifications.js) - a tap opens the prayer screen
              // and the message is filed under "prayer" in the notification inbox
              data: { prayer: p, screen: 'prayer', category: 'prayer' },
              // Android app: the "prayer" notification channel (created by the app), delivered immediately, and a newer
              // reminder of the same prayer replaces the old one. A reminder older than an hour is no longer useful.
              android: {
                priority: 'high',
                ttl: 60 * 60 * 1000,
                notification: { channelId: 'prayer', tag: 'prayer-' + p }
              },
              webpush: {
                notification: { icon: '/icons/icon-192.png' },
                fcmOptions: { link: '/' }
              }
            });
            console.log(`Sent ${p} notification to ${doc.id}`);
          } catch (err) {
            if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
              await doc.ref.delete();
              console.log(`Removed stale subscription ${doc.id}`);
              removed = true;
              break;
            }
            console.error(`Send failed for ${doc.id}:`, err.message);
          }
          sentToday.push(p);
        }
      }

      // Only write back to Firestore if something actually changed (a
      // notification was sent, or the day rolled over) — keeps daily writes
      // to at most ~5 per device instead of one per cron run.
      if (!removed && (sentToday.length !== startCount || sub.lastNotifiedDate !== today)) {
        await doc.ref.set({ lastNotifiedDate: today, lastNotifiedPrayers: sentToday }, { merge: true });
      }
    } catch (e) {
      console.error(`Subscription ${doc.id} failed:`, e.message);
    }
  }
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
