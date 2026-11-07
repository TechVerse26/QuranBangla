// ---------- Firebase project config ----------
// Paste the config object from Firebase Console → Project settings →
// General → "Your apps" → SDK setup and configuration → Config.
// This is the ONLY file you need to edit to connect the app to your own
// Firebase project. Everything else (auth screens, Firestore sync logic)
// is already wired up in js/auth.js.
//
// PRIVACY NOTE: Firestore only ever receives aggregate progress numbers —
// daily reading seconds (by date), search count, best streak, unique
// ayahs-read count, unique surahs-listened count, and the taraweeh rakat
// tracker. It NEVER receives bookmarks, notes, reading history, last-read
// position, or which specific surahs/ayahs were read — those stay only in
// this browser's localStorage on each device. See buildSyncSnapshot() in
// js/auth.js if you want to double-check exactly what gets uploaded.
//
// As of the login-history feature (js/session-security.js), Firestore also
// stores, per real sign-in, a session record under users/{uid}/sessions/{id}:
// browser + OS + device type, an IP-based approximate city/country/ISP, and
// timestamps. It never stores WiFi names or SIM/carrier names — no website
// can read those, by browser design.
//
// Also make sure, in the Firebase Console, you have:
//   1) Authentication → Sign-in method → enabled "Email/Password" and "Google".
//   2) Firestore Database → created a database (production or test mode).
//   3) Firestore → Rules → something like the rules below, so each user can
//      only read/write their own document:
//
//   rules_version = '2';
//   service cloud.firestore {
//     match /databases/{database}/documents {
//       match /users/{uid} {
//         allow read, write: if request.auth != null && request.auth.uid == uid;
//         // Login-history / active-session records (see js/session-security.js).
//         // Same owner-only rule — nobody but this account can ever read or
//         // revoke its own session list, including the "log out everywhere"
//         // link sent by email.
//         match /sessions/{sessionId} {
//           allow read, write: if request.auth != null && request.auth.uid == uid;
//         }
//       }
//     }
//   }
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDba6MzA2OfawaQrdqSoP-3_ew6xldJIX4",
  authDomain: "quranfreeapps.firebaseapp.com",
  projectId: "quranfreeapps",
  storageBucket: "quranfreeapps.firebasestorage.app",
  messagingSenderId: "421704127278",
  appId: "1:421704127278:web:79e948fb9f7914951920bf",
  measurementId: "G-094TKJ49YH"
};

// ---------- Password reset (Firebase Authentication এর নিজস্ব built-in সিস্টেম) ----------
// fbAuth.sendPasswordResetEmail(email, PASSWORD_RESET_ACTION_CODE_SETTINGS) —
// js/auth.js ও js/profile-view.js এই একই কনফিগ ব্যবহার করে। কোনো কাস্টম
// API/সার্ভার/থার্ড-পার্টি SMTP নেই — Firebase নিজেই oobCode-সহ secure লিংক
// বানায় এবং ইমেইল পাঠায়। ইমেইলের ভাষা/ডিজাইন বদলাতে চাইলে: Firebase Console
// → Authentication → Templates → Password reset।
//
// url অবশ্যই এই অ্যাপের নিজস্ব index.html হতে হবে (Firebase-এর ডিফল্ট
// firebaseapp.com পেজ না), যাতে ইমেইলের লিংকে ক্লিক করলে
// ?mode=resetPassword&oobCode=... সহ সরাসরি এখানে ফেরত আসে —
// js/reset-password.js এই প্যারামিটার দুটো পড়ে "নতুন পাসওয়ার্ড দিন" স্ক্রিন
// দেখায়। অ্যাপের ডোমেইন বদলালে নিচের url-ও বদলে দিতে হবে, এবং সেই ডোমেইন
// Firebase Console → Authentication → Settings → Authorized domains-এ যোগ
// করা থাকতে হবে (Vercel দিলে ওটা এমনিতেই যোগ করা থাকার কথা)।
const PASSWORD_RESET_ACTION_CODE_SETTINGS = {
  url: 'https://quranbangla.vercel.app/index.html',
  handleCodeInApp: true
};
