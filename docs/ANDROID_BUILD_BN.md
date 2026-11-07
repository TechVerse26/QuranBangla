# Android অ্যাপ — বিল্ড, সেটআপ ও রিলিজ গাইড

এই গাইড GitHub Actions দিয়ে **Debug APK**, **signed Release APK** ও **AAB (Google Play)** বানানোর জন্য।
অ্যাপের ভেতরের গঠন ও ফাইল ম্যাপ আছে [`ANDROID_APP.md`](ANDROID_APP.md)-তে, পরীক্ষার ফলাফল [`TEST_REPORT.md`](TEST_REPORT.md)-এ।

> **সৎ কথা আগে:** এই কাজ যে পরিবেশে করা হয়েছে সেখানে npm/Maven/Gradle সাইট বন্ধ ছিল এবং Android SDK ছিল না। তাই
> **APK এখানে বানানো বা কোনো ফোনে চালিয়ে দেখা যায়নি।** কোড, বিল্ড-স্ক্রিপ্ট ও workflow যতটা সম্ভব আলাদাভাবে পরীক্ষা করা হয়েছে
> (দেখুন [`TEST_REPORT.md`](TEST_REPORT.md)), কিন্তু **আসল প্রথম GitHub বিল্ডই চূড়ান্ত পরীক্ষা**। প্রথম রানে কিছু ভুল ধরা পড়তে পারে —
> তখন Actions রানের **Summary** ট্যাবে কোন ধাপ কেন ব্যর্থ হয়েছে তা পরিষ্কার লেখা থাকবে (§৮ দেখুন)।

---

## ১. মূল ধারণা (২ মিনিটে)

| বিষয় | কীভাবে আছে |
|---|---|
| **ওয়েবসাইট** (`quranbangla.vercel.app`) | আগের মতোই। হেডার, ফুটার, রুট, SEO, রেসপনসিভ ডিজাইন — কিছুই বদলায়নি। Vercel-এ যেভাবে ডিপ্লয় হতো সেভাবেই হবে। |
| **অ্যান্ড্রয়েড অ্যাপ (APK)** | লাইভ সাইটকে Capacitor 8 দিয়ে মোড়ানো অ্যাপ (`server.url`)। অ্যাপের ভেতরে চললে `js/platform.js` তা শনাক্ত করে (`Capacitor.isNativePlatform()` + User-Agent টোকেন `QuranBanglaApp/…`) এবং `/app` ফোল্ডারের **আলাদা অ্যাপ-UI** চালু করে: নিচে বটম নেভিগেশন (হোম · কুরআন · আবিষ্কার · সংরক্ষিত · আরও), টপ বার, বটম শিট, আলাদা রিডার ইত্যাদি। |
| **সাধারণ ব্রাউজারে** | `/app`-এর কোনো CSS/JS লোডই হয় না — অ্যাপের স্টাইল ওয়েবসাইটে ঢোকার সুযোগ নেই। |
| **ব্যাকএন্ড** | একই: Firebase Auth/Firestore (`quranfreeapps`), Quran API, অডিও সোর্স। কোনো গোপন কী APK বা ফ্রন্টএন্ডে নেই। |
| **অ্যাপ-UI আপডেট** | Vercel-এ ডিপ্লয় করলেই হয় — **নতুন APK লাগে না**। (শুধু `js/data.js`-এ `SW_VERSION` বাড়াতে হবে, §১১ দেখুন।) |
| **নতুন APK কখন লাগে** | নেটিভ কিছু বদলালে: আইকন, পারমিশন, প্লাগইন, ভার্সন, Firebase কনফিগ, Capacitor আপগ্রেড। |

APK কীভাবে তৈরি হয়: workflow প্রতিবার নতুন Capacitor প্রজেক্ট বানায় (`npx cap add android`), তারপর
`android-build/apply-native-patches.mjs` সেটার ম্যানিফেস্ট, Gradle, রিসোর্স, আইকন, স্প্ল্যাশ ইত্যাদি প্যাচ করে।
Android প্রজেক্ট কখনো repo-তে কমিট করা থাকে না।

---

## ২. প্রথমবার যা অবশ্যই করতে হবে (চেকলিস্ট)

| # | কাজ | কেন | কোথায় |
|---|---|---|---|
| 1 | **`app-config.js`-এ `supportEmail` ও `developerName` বসান** | Google Play-র গোপনীয়তা নীতিতে ডেভেলপারের নাম ও যোগাযোগের ঠিকানা লাগে। ফাঁকা থাকলে নীতি-পাতায় কোনো ইমেইল দেখায় না। **আমি নিজে থেকে কোনো ইমেইল বসাইনি** — সবার সামনে যে ঠিকানা দেখাতে চান সেটাই দিন। | `app-config.js` (§৩) |
| 2 | Firebase-এ Android অ্যাপ নিবন্ধন → `GOOGLE_SERVICES_JSON` secret | নামাজের পুশ নোটিফিকেশনের জন্য। না দিলে বিল্ড সফল হয়, কিন্তু অ্যাপে ওয়াক্তের নোটিফিকেশন চালু করা যায় না। | §৪.১ |
| 3 | Release keystore তৈরি → ৪টি secret | Google Play-র জন্য signed APK/AAB। শুধু debug APK টেস্ট করলে লাগবে না। | §৪.২ |
| 4 | (ঐচ্ছিক) `ANDROID_DEBUG_KEYSTORE_BASE64` | debug APK একটার ওপর আরেকটা ইনস্টল করতে (আনইনস্টল ছাড়া)। | §৪.৩ |
| 5 | (ঐচ্ছিক) `siteConfig/announcement`, `siteConfig/appConfig` ডকুমেন্ট | অ্যাপে ঘোষণা ও "নতুন সংস্করণ" নোটিশ দেখাতে। | §৯ |
| 6 | (ঐচ্ছিক) `.well-known/assetlinks.json` | ওয়েবসাইটের লিংক (যেমন `…/?surah=18&ayah=10`) অ্যাপে খুলতে। | §৭ |
| 7 | Play Console ফর্ম: Data safety, গোপনীয়তা নীতির URL, অ্যাকাউন্ট মোছার URL | Google Play-তে প্রকাশের জন্য। | §১০ |

---

## ৩. `app-config.js` (আবশ্যক)

```js
window.QR_APP_CONFIG = {
  appName: 'কুরআন বাংলা',
  appNameEn: 'Quran Bangla',
  siteUrl: 'https://quranbangla.vercel.app',
  supportEmail: '',      // ← এখানে আপনার সাপোর্ট ইমেইল (প্রকাশ্যে দেখাবে)
  developerName: ''      // ← আপনার নাম / প্রতিষ্ঠানের নাম
};
```

- এই ফাইল সবার জন্য খোলা — **এতে কোনো গোপন তথ্য রাখবেন না**।
- এখানে একবার বসালেই `privacy.html`, `terms.html`, `account-deletion.html` এবং অ্যাপের "সম্পর্কে" ও "সমস্যা জানান" স্ক্রিনে বসে যাবে।
- "সমস্যা জানান" অ্যাপের ভেতরের ফর্ম — বার্তা অ্যাডমিন প্যানেলের মনিটরিং ট্যাবে (`system_errors`) জমা হয় — `supportEmail` ছাড়াও কাজ করে। `supportEmail` বসালে ফর্মের নিচে "ইমেইলেও লিখতে পারেন" লাইন এবং "আরও › সম্পর্কে"-তে ইমেইলের সারি যোগ হয়; ফাঁকা থাকলে নীতি-পাতায় ঠিকানার জায়গা লুকানো থাকে।
- release বিল্ডে (`build_type = release` বা `both`) preflight ধাপ এই দুটি ফাঁকা থাকলে **সতর্কতা (warning)** দেয়।

---

## ৪. GitHub Secrets

Repository → **Settings → Secrets and variables → Actions → New repository secret**।
Debug বিল্ডের জন্য কোনো secret ছাড়াই চলে।

| Secret | লাগে কখন | মান |
|---|---|---|
| `GOOGLE_SERVICES_JSON` | পুশ নোটিফিকেশন চাইলে | `google-services.json` ফাইলের পুরো লেখা (JSON অথবা base64) |
| `ANDROID_KEYSTORE_BASE64` | release বিল্ড | keystore ফাইলের base64 |
| `ANDROID_KEYSTORE_PASSWORD` | release বিল্ড | keystore-এর পাসওয়ার্ড |
| `ANDROID_KEY_ALIAS` | release বিল্ড | কী-এর alias (নিচের উদাহরণে `quranbangla`) |
| `ANDROID_KEY_PASSWORD` | release বিল্ড | কী-এর পাসওয়ার্ড |
| `ANDROID_DEBUG_KEYSTORE_BASE64` | ঐচ্ছিক | স্থায়ী debug কী-এর base64 |

> secret-এর মান কখনো লগে ছাপা হয় না, কোনো ফাইলে লেখা হয় না (শুধু রানারের অস্থায়ী ফোল্ডারে keystore থাকে এবং রান শেষে মুছে ফেলা হয়)।
> `google-services.json` বা keystore **কখনোই repo-তে কমিট করবেন না**।

### ৪.১ `GOOGLE_SERVICES_JSON` (পুশ নোটিফিকেশন)

1. [Firebase Console](https://console.firebase.google.com) → ওয়েবসাইট যে প্রজেক্ট ব্যবহার করে সেটি খুলুন (**`quranfreeapps`** — `js/firebase-config.js`-এর `projectId`)।
   **অ্যাপ ও ওয়েবসাইট একই Firebase প্রজেক্ট হতে হবে**, নইলে ওয়েবসাইটের প্রজেক্ট থেকে পাঠানো পুশ অ্যাপে পৌঁছাবে না।
2. ⚙ **Project settings → General → Your apps → Add app → Android**।
3. **Android package name:** `com.techverse.quranbangla` (হুবহু)। নিকনেম যা খুশি। SHA-1 লাগবে না (অ্যাপে Google sign-in নেই)।
4. `google-services.json` ডাউনলোড করুন, ফাইলটি খুলে **পুরো লেখা** কপি করে `GOOGLE_SERVICES_JSON` নামের secret-এ বসান।
5. বিল্ড স্ক্রিপ্ট নিজে যাচাই করে: package নাম মেলে কি না (না মিললে বিল্ড থামে), Firebase প্রজেক্ট ওয়েবসাইটের সাথে মেলে কি না (না মিললে সতর্কতা)।
   যাচাই সফল হলে APK-র User-Agent টোকেনে `fcm` ফ্ল্যাগ বসে, আর তখনই অ্যাপ পুশ রেজিস্ট্রেশন চেষ্টা করে।

**secret না দিলে কী হয়:** বিল্ড সফল হয় (Summary-তে "Push notifications … NOT enabled" লেখা থাকে)। অ্যাপে "ওয়াক্তের নোটিফিকেশন" চালু করতে গেলে
"এই সংস্করণে ওয়াক্তের নোটিফিকেশন এখনো চালু নেই" বার্তা আসে। দৈনিক তিলাওয়াতের রিমাইন্ডার (ফোনেই সেট হয়) ও বাকি সব ফিচার কাজ করে।
এটা ইচ্ছাকৃত: Firebase কনফিগ ছাড়া নেটিভ `register()` কল করলে Android অ্যাপ ক্র্যাশ করতে পারে, তাই কল করাই হয় না।

**সার্ভার দিক (আগের মতোই):** `.github/workflows/prayer-notify.yml` ও `scripts/send-prayer-notifications.js` ওয়াক্ত হিসাব করে পুশ পাঠায় (`FIREBASE_SERVICE_ACCOUNT` secret — `SETUP_PRAYER_PUSH.txt` দেখুন)।
অ্যাপের টোকেনও ওয়েবসাইটের মতো একই `push_subscriptions/{deviceId}` ডকুমেন্টে (`token, lat, lon, method, updatedAt`) যায়, তাই নতুন সার্ভার বা **Firestore রুল বদলাতে হয় না**।
অ্যাপের জন্য পুশে `data.screen = "prayer"` ও চ্যানেল `prayer` যোগ হয়েছে — ট্যাপ করলে নামাজের স্ক্রিন খোলে।

### ৪.২ Release keystore (Google Play-র জন্য)

নিজের কম্পিউটারে (JDK-র `keytool` লাগে):

```bash
keytool -genkeypair -v -keystore quranbangla-release.jks -alias quranbangla \
  -keyalg RSA -keysize 2048 -validity 10000
```

প্রশ্নগুলোর উত্তর ও পাসওয়ার্ড দিন (পাসওয়ার্ড দুটি লিখে রাখুন)। তারপর base64:

```bash
# Linux
base64 -w0 quranbangla-release.jks > keystore.base64.txt
# macOS
base64 -i quranbangla-release.jks | tr -d '\n' > keystore.base64.txt
# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("quranbangla-release.jks")) | Set-Content keystore.base64.txt
```

`keystore.base64.txt`-এর পুরো লেখা → `ANDROID_KEYSTORE_BASE64`। পাসওয়ার্ড → `ANDROID_KEYSTORE_PASSWORD` ও `ANDROID_KEY_PASSWORD`। alias (`quranbangla`) → `ANDROID_KEY_ALIAS`।

> ⚠️ **keystore ফাইল ও পাসওয়ার্ড নিরাপদ জায়গায় ব্যাকআপ রাখুন** (পাসওয়ার্ড ম্যানেজার + অফলাইন কপি)। Google Play-তে **Play App Signing** চালু রাখুন (নতুন অ্যাপে ডিফল্ট):
> তখন এই keystore শুধু "আপলোড কী", হারালে Play Console থেকে আপলোড কী রিসেট করা যায়। Play App Signing ছাড়া হারালে আর আপডেট দেওয়া যায় না।

workflow রান করার আগে `keytool -list` দিয়ে পাসওয়ার্ড/alias মেলে কি না যাচাই করে — ভুল হলে পরিষ্কার বার্তা দিয়ে থামে।

### ৪.৩ স্থায়ী debug কী (ঐচ্ছিক)

ডিফল্টে প্রতিটি রানে নতুন debug কী তৈরি হয়, তাই নতুন debug APK ইনস্টলের আগে পুরোনো debug অ্যাপ **আনইনস্টল** করতে হয়।
আনইনস্টল এড়াতে একবার একটি স্থায়ী debug কী বানিয়ে secret-এ রাখুন:

```bash
keytool -genkey -v -keystore debug.keystore -storepass android -alias androiddebugkey -keypass android \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
base64 -w0 debug.keystore      # → ANDROID_DEBUG_KEYSTORE_BASE64
```

(পাসওয়ার্ড `android` ও alias `androiddebugkey` রাখতে হবে — Android Gradle প্লাগইন ঠিক এগুলোই খোঁজে। debug কী গোপন কিছু নয়, কিন্তু release-এ কখনো ব্যবহার করবেন না।)

---

## ৫. বিল্ড চালানো

**GitHub → Actions → "Build Android app" → Run workflow**। ঘরগুলো:

| ঘর | অর্থ |
|---|---|
| `build_type` | `debug` (টেস্টের জন্য, ডিফল্ট) · `release` (signed APK + AAB, secrets লাগবে) · `both` |
| `version_name` | ব্যবহারকারী যা দেখে, যেমন `1.2.0`। ফাঁকা = workflow ফাইলের `DEFAULT_VERSION_NAME` (এখন `1.1.0`)। |
| `version_code` | পূর্ণসংখ্যা। ফাঁকা = **`100 + run নম্বর`** (সবসময় বাড়ে)। |
| `publish_release` | চালু থাকলে APK GitHub Releases-এও রাখা হয়। |
| `release_notes` | ঐচ্ছিক নোট — Release-এর বিবরণে যোগ হয়। |

স্বয়ংক্রিয়: `.github/workflows/build-apk.yml` বা `android-build/**` বদলে push করলে debug বিল্ড চলে। ওয়েবসাইট/অ্যাপ-UI ফাইল বদলালে APK বিল্ড চলে না (দরকারও নেই)।

রানের ধাপগুলো (ক্রমানুসারে): সেটিংস যাচাই → **self-test** (প্যাচ স্ক্রিপ্টের নিজস্ব পরীক্ষা) → **preflight** (repo-র সব JS-এর সিনট্যাক্স, অ্যাপ-UI ফাইল, প্রিক্যাশ তালিকা, আইকন ইত্যাদি)
→ Capacitor প্রজেক্ট তৈরি ও প্যাচ → debug / release বিল্ড → **APK অডিট** → artifacts ও Releases।

### ফলাফল কোথায়

| কী | কোথায় |
|---|---|
| Debug APK | রান পাতার নিচে **Artifacts → `QuranBangla-debug-apk`**; এবং **Releases → `build-<run নম্বর>`** (prerelease) |
| Signed Release APK + AAB + `SHA256SUMS.txt` | **Artifacts → `QuranBangla-release`**; APK **Releases → `v<ver>-<code>`**-এও থাকে (AAB শুধু Artifacts-এ) |
| প্যাচ রিপোর্ট, অডিট রিপোর্ট, Gradle লগ | **Artifacts → `build-reports`** এবং রানের **Summary** ট্যাব |

ফাইলের নাম: `QuranBangla-<versionName>-<versionCode>-debug.apk` / `-release.apk` / `-release.aab`।

---

## ৬. APK অডিট কী যাচাই করে

বিল্ডের পর `android-build/audit-apk.mjs` APK-র ভেতর দেখে Summary-তে টেবিল দেয়:

- package নাম ও versionName / versionCode ঠিক আছে কি না;
- **পারমিশনের সঠিক তালিকা** — অনুমোদিত: `INTERNET`, `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS`, `VIBRATE`, `RECEIVE_BOOT_COMPLETED`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`
  (+ Firebase/AndroidX-এর সাধারণ `WAKE_LOCK`, `com.google.android.c2dm.permission.RECEIVE`)। নিষিদ্ধ (পেলে ত্রুটি): exact alarm, স্টোরেজ, ফোন/SMS/কন্ট্যাক্ট, ক্যামেরা/মাইক, foreground service, বিজ্ঞাপন-আইডি, ব্যাকগ্রাউন্ড লোকেশন ইত্যাদি;
- signing সার্টিফিকেট — **release APK-তে debug কী থাকলে ত্রুটি**; সার্টিফিকেটের SHA-256 ও তৈরি-করা `assetlinks.json` ছাপা হয়;
- `allowBackup=false`, `quranbangla://` ও https লিংক ফিল্টার, লঞ্চার শর্টকাট, নেটিভ লাইব্রেরির 16 KB অ্যালাইনমেন্ট।

> অডিটের পার্সারগুলো এখানে শুধু নমুনা টেক্সটে পরীক্ষা করা গেছে (এখানে `aapt2`/`apksigner` ছিল না)। প্রথম আসল রানে অডিটের আউটপুট একবার চোখে দেখে নিন।

---

## ৭. App Links (ঐচ্ছিক)

অ্যাপ `https://quranbangla.vercel.app/` ও `/index.html` পাথের লিংক (query সহ, যেমন `/?surah=18&ayah=10`) খুলতে পারে। `privacy.html` ইত্যাদি অন্য পাতা ইচ্ছা করেই ব্রাউজারে খোলে।
Android-কে যাচাই করাতে (`autoVerify`) ওয়েবসাইটে এই ফাইল লাগবে: `https://quranbangla.vercel.app/.well-known/assetlinks.json`।

1. release বিল্ডের Summary-তে ছাপা JSON-টি repo-তে `.well-known/assetlinks.json` নামে কমিট করুন (Vercel ডিপ্লয় হবে)।
2. **Play App Signing** চালু থাকলে Google নিজের কী দিয়ে অ্যাপ সাইন করে — Play Console → *Setup → App signing*-এ দেখানো **SHA-256** আরেকটি এন্ট্রি হিসেবে `sha256_cert_fingerprints` তালিকায় যোগ করুন।
3. যাচাই: ব্রাউজারে ফাইলটি খুলে JSON দেখা যাচ্ছে কি না দেখুন (Content-Type `application/json`)।

না করলেও অ্যাপ ঠিক চলে — শুধু ব্রাউজার থেকে লিংকে ট্যাপ করলে অ্যাপ নিজে থেকে খুলবে না (`quranbangla://` লিংক ও শর্টকাট এমনিতেই কাজ করে)।

---

## ৮. সমস্যা সমাধান

বিল্ড ব্যর্থ হলে প্রথমে রানের **Summary** দেখুন, তারপর `build-reports` artifact (`qr-patch-report.*.json`, `gradle-*.log`)।
ব্যর্থ হলেও (ডিবাগ বিল্ডের ক্ষেত্রে) একটি **SAFE MODE APK** বানানোর চেষ্টা হয় — ওটা সীমিত ফিচারের, শুধু "হাতে কিছু ইনস্টল করার মতো থাকুক" সে জন্য, আর রান তবু **লাল (failed)** দেখায়।

| বার্তা / লক্ষণ | মানে ও সমাধান |
|---|---|
| `A release build needs these repository secrets: …` | release-এর ৪টি secret সব দিন (§৪.২)। |
| `The keystore could not be opened with this password / key alias` | `ANDROID_KEYSTORE_PASSWORD` বা `ANDROID_KEY_ALIAS` ভুল; base64 কপির সময় লাইন-ব্রেক ঢুকলেও এমন হয় (`base64 -w0` ব্যবহার করুন)। |
| `google-services.json has no Android app with package name …` | Firebase-এ package ঠিক `com.techverse.quranbangla` দিয়ে অ্যাপ নিবন্ধন করে ফাইল আবার নামান। |
| `GOOGLE_SERVICES_JSON secret is not set` (warning) | স্বাভাবিক — পুশ ছাড়া বিল্ড হচ্ছে (§৪.১)। |
| `… is neither valid JSON nor base64-encoded JSON` | secret-এ ফাইলের পুরো লেখা বসেনি। |
| `unresolved resource reference(s): …` | প্যাচ স্ক্রিপ্টের নিজস্ব সুরক্ষা — রিপোর্টে কোন রিসোর্স নেই দেখুন। |
| Gradle ব্যর্থ | Summary-র "Last lines of the Gradle log" এবং `gradle-debug-full.log` দেখুন। |
| `Optional plugin … could not be installed` (warning) | ঐচ্ছিক `@capawesome/capacitor-app-update` নামেনি — অ্যাপ তখন Firestore-এর `appConfig` নোটিশ দিয়ে আপডেট জানায়। |
| নতুন debug APK ইনস্টল হচ্ছে না ("App not installed") | আগের debug অ্যাপ আনইনস্টল করুন, অথবা §৪.৩ অনুযায়ী স্থায়ী debug কী দিন। |
| অ্যাপে নতুন UI-র বদলে পুরোনো ওয়েবসাইট-UI দেখাচ্ছে | (ক) পুরোনো APK (যেটাতে `App` প্লাগইন নেই) — নতুন APK ইনস্টল করুন; (খ) অ্যাপ-UI ১২ সেকেন্ডে চালু না হলে ওই সেশনের জন্য নিজে থেকে ওয়েবসাইট-UI-তে ফিরে যায়। কারণ জানতে ফোন USB-তে দিয়ে Chrome → `chrome://inspect`-এ কনসোলে `[platform] app UI failed to start:` দেখুন। |
| অফলাইনে প্রথম খোলায় "সংযোগ নেই" পাতা | অ্যাপ লাইভ সাইট লোড করে। একবার সফলভাবে খোলার পর Service Worker ক্যাশ থেকে অফলাইনেও চলে; ডেটা মুছে ফেললে আবার ইন্টারনেট লাগে। |

লোকাল মেশিনে হাতে বানাতে চাইলে (Node 22, JDK 21, Android SDK লাগবে):

```bash
export APP_ID=com.techverse.quranbangla APP_NAME="Quran Bangla" APP_VERSION=1.1.0 APP_VERSION_CODE=101 \
       LIVE_URL=https://quranbangla.vercel.app QR_PROJECT_DIR=/tmp/app
node android-build/self-test.mjs && node android-build/preflight.mjs
bash android-build/create-project.sh full      # [safe] = সীমিত ফলব্যাক
cd /tmp/app/android && ./gradlew assembleDebug
```

---

## ৯. Firestore ডকুমেন্ট (ঘোষণা ও আপডেট নোটিশ — ঐচ্ছিক)

`siteConfig`-এর নিরাপত্তা-রুলে সবাই **পড়তে** পারে, **লেখা যায় না** (`allow write: if false`) — তাই ডকুমেন্টগুলো **Firebase Console → Firestore** থেকে হাতে তৈরি/সম্পাদনা করতে হবে। রুল বদলাতে হয়নি।

**`siteConfig/announcement`** — অ্যাপের হোম স্ক্রিনে ঘোষণা:

| ফিল্ড | ধরন | অর্থ |
|---|---|---|
| `active` | boolean | `false` দিলে লুকায় |
| `id` | string | ব্যবহারকারী "বন্ধ করলে" এই id মনে রাখা হয়; নতুন ঘোষণায় নতুন id দিন |
| `title`, `text` | string | শিরোনাম ও লেখা (একটি থাকলেই হয়) |
| `link`, `linkLabel` | string | ঐচ্ছিক বাটন (শুধু `https://`) |
| `startsAt`, `endsAt` | timestamp | ঐচ্ছিক সময়সীমা |
| `audience` | string | `all` (ডিফল্ট) বা `android` |

**`siteConfig/appConfig`** — "নতুন সংস্করণ" নোটিশ:

| ফিল্ড | অর্থ |
|---|---|
| `latestVersionCode` | সংখ্যা। অ্যাপের build (`versionCode`) এর চেয়ে বড় হলে নোটিশ দেখায় |
| `latestVersionName` | যেমন `1.2.0` |
| `updateMessage` | বার্তা |
| `updateUrl` | https লিংক (Play Store পাতা) |

(`@capawesome/capacitor-app-update` ইনস্টল থাকলে এবং অ্যাপ Google Play থেকে ইনস্টল হলে "সম্পর্কে → আপডেট খুঁজুন" Play-র নিজস্ব In-App Update পথও ব্যবহার করে।)

---

## ১০. Google Play চেকলিস্ট

> আমি Google Play-র অনুমোদনের কোনো দাবি করছি না — নিচেরগুলো প্রস্তুতির তালিকা। Play Console-এর বর্তমান নিয়ম আপনাকেই যাচাই করতে হবে।

**বিল্ড ও ফাইল**
- [ ] `build_type = release` বা `both` চালান → `.aab` (`QuranBangla-release` artifact) Play Console-এ আপলোড করুন। প্রতিবার `version_code` আগের আপলোডের চেয়ে **বড়** হতে হবে (অটো ঠিক থাকে)।
- [ ] **Play App Signing** চালু রাখুন (§৪.২)।
- [ ] Target API: Capacitor 8 টেমপ্লেট সাধারণত API 36 টার্গেট করে। প্যাচ স্ক্রিপ্ট `variables.gradle` থেকে পড়ে 35-এর নিচে হলে সতর্ক করে; Play-র বর্তমান ন্যূনতম টার্গেট Console-এ দেখে নিন।
- [ ] অ্যাপে নিজস্ব native (C/C++) লাইব্রেরি নেই; অডিট 16 KB পেজ-সাইজ অ্যালাইনমেন্ট যাচাই করে।

**নীতি ও ফর্ম**
- [ ] গোপনীয়তা নীতির URL: `https://quranbangla.vercel.app/privacy.html` (বাংলা/ইংরেজি, বাটনে ভাষা বদলায়)। আগে `app-config.js` পূরণ করুন (§৩)।
- [ ] অ্যাকাউন্ট মোছার URL (Data safety-র "Account deletion" ঘরে): `https://quranbangla.vercel.app/account-deletion.html`। অ্যাপের ভেতর থেকেও মোছা যায় (আরও › অ্যাকাউন্ট › অ্যাকাউন্ট মুছুন)।
- [ ] শর্তাবলি: `https://quranbangla.vercel.app/terms.html`। ⚠️ এতে **প্রযোজ্য আইন/এখতিয়ার (governing law)-এর ধারা নেই** — প্রকাশের আগে নিজে বা আইনজীবীকে দিয়ে দেখিয়ে নিন।
- [ ] নীতি-পাতাগুলোতে লেখা প্রতিশ্রুতি (যেমন মোছার অনুরোধ "সাধারণত ৩০ দিনের মধ্যে") আপনি আসলেই রাখতে পারবেন কি না নিশ্চিত করুন।
- [ ] **Data safety ফর্ম** — কোডের ভিত্তিতে খসড়া (নিজে যাচাই করে জমা দিন):

| ডেটা | সংগ্রহ? | উদ্দেশ্য | মন্তব্য |
|---|---|---|---|
| নাম, ইমেইল | হ্যাঁ, ঐচ্ছিক (অ্যাকাউন্ট খুললে) | অ্যাকাউন্ট, অ্যাপের কাজ | EmailJS ইমেইল পাঠায় (সেবাদাতা) |
| ঐচ্ছিক প্রোফাইল (ছবি, ফোন, জেলা, জন্মতারিখ, বায়ো) | হ্যাঁ, ঐচ্ছিক | অ্যাপের কাজ | ব্যবহারকারী নিজে দেয় |
| অ্যাপ কার্যকলাপ (পড়ার অগ্রগতির সারসংক্ষেপ) | হ্যাঁ (সাইন-ইন থাকলে) | অ্যাপের কাজ (সিঙ্ক) | বুকমার্ক/নোট/ইতিহাস ডিভাইসেই থাকে, সার্ভারে যায় না |
| আনুমানিক অবস্থান | নামাজের নোটিফিকেশন চালু করলে (Firestore) | অ্যাপের কাজ | অক্ষাংশ/দ্রাঘিমাংশ **AlAdhan** API-কে পাঠানো হয় — "শেয়ার" হিসেবে ঘোষণা করা নিরাপদ |
| ডিভাইস/অন্যান্য আইডি | হ্যাঁ (নোটিফিকেশন চালু হলে) | অ্যাপের কাজ | FCM টোকেন + এলোমেলো ডিভাইস আইডি |
| সাইন-ইন রেকর্ড (আইপি, আনুমানিক শহর/দেশ, ডিভাইসের ধরন) | হ্যাঁ (সাইন-ইন থাকলে) | নিরাপত্তা | আইপি-থেকে-অবস্থানের জন্য ipapi.co / ipwho.is |
| ত্রুটির লগ ও "সমস্যা জানান"-এর বার্তা | হ্যাঁ | অ্যাপের কাজ / ডায়াগনস্টিক | শুধু অ্যাডমিন দেখে |
| AI তাফসীরের প্রশ্ন | সার্ভার হয়ে Google Gemini-তে যায় | অ্যাপের কাজ | আমরা লেখা জমা রাখি না; শুধু দৈনিক-সীমার কাউন্টার |

  "ট্রানজিটে এনক্রিপ্টেড": হ্যাঁ (HTTPS)। "ডেটা মোছার অনুরোধ": হ্যাঁ। বিজ্ঞাপন: নেই। শিশুদের জন্য ডিজাইন করা: না — লক্ষ্য-দর্শক ঘরে সিদ্ধান্ত আপনার।
- [ ] পারমিশন: ব্যাকগ্রাউন্ড লোকেশন, exact alarm, স্টোরেজ ইত্যাদি **নেই**; তাই বিশেষ পারমিশন ঘোষণা লাগার কথা নয় (অডিট নিশ্চিত করে)।
- [ ] কনটেন্ট রেটিং প্রশ্নমালা, স্টোর লিস্টিং (আইকন 512×512, ফিচার গ্রাফিক 1024×500, **আসল ফোন/এমুলেটরের স্ক্রিনশট**, ছোট/বড় বিবরণ) — এগুলো আমি বানাইনি।
- [ ] নতুন ব্যক্তিগত ডেভেলপার অ্যাকাউন্টে প্রোডাকশনের আগে ক্লোজড টেস্ট (বর্তমান নিয়মে নির্দিষ্ট সংখ্যক টেস্টার, নির্দিষ্ট দিন) লাগতে পারে — Play Console-এর সাহায্য-পাতায় বর্তমান নিয়ম দেখুন।

---

## ১১. ওয়েবসাইট/অ্যাপ-UI আপডেটের নিয়ম

- **`SW_VERSION` বাড়ান** (`js/data.js`, এখন `v1.03.0`): ওয়েবসাইট বা `/app`-এর কোনো ফাইল বদলালে। Service Worker same-origin ফাইল cache-first দেয়; ভার্সন না বদলালে ইনস্টল-করা ব্যবহারকারীরা পুরোনো ফাইল পেতে থাকবে।
- অ্যাপ-UI-তে নতুন ফাইল যোগ করলে `js/platform.js`-এর `APP_STYLES` / `APP_SCRIPTS` তালিকায় (ক্রম গুরুত্বপূর্ণ) যোগ করুন। তালিকার কোনো ফাইল না থাকলে `node android-build/preflight.mjs` ত্রুটি দেখায়।
- ওয়েবসাইটের নতুন প্রিক্যাশ ফাইল হলে `js/data.js`-এর `APP_SHELL_CORE` / `APP_SHELL_DEFERRED`-এ যোগ করুন — preflight প্রতিটি এন্ট্রির ফাইল আছে কি না দেখে (একটি 404 পুরো অফলাইন ক্যাশ ভেঙে দেয়)।
- নতুন ভার্সনের APK দিতে চাইলে: `version_name` বদলান (বা `DEFAULT_VERSION_NAME`), বিল্ড চালান, এবং চাইলে `siteConfig/appConfig`-এ `latestVersionCode` বসান।

---

## ১২. জানা সীমাবদ্ধতা (অকপটে)

1. **APK এখানে বানানো/চালানো হয়নি** (উপরের নোট)। যা যাচাই হয়েছে: সব JS-এর সিনট্যাক্স; প্যাচ স্ক্রিপ্ট একটি *অনুকরণ-করা* Capacitor টেমপ্লেটের বিরুদ্ধে (সত্যিকারের Capacitor/Gradle নয়);
   workflow-র কাঠামো ও bash ধাপ; ব্রাউজারে (Chromium) নকল `window.Capacitor` দিয়ে অ্যাপ-UI। যা **শুধু আসল ফোনে** যাচাই হবে: স্প্ল্যাশের সময়, স্ট্যাটাস/নেভিগেশন বারের ইনসেট, হার্ডওয়্যার ব্যাক, শেয়ার শিট, নোটিফিকেশন চ্যানেল ও FCM ডেলিভারি, শর্টকাট, App Links।
2. **নোটিফিকেশনে ট্যাপ করে "বন্ধ থাকা" অ্যাপ খোলা:** কোন স্ক্রিনে যাবে তা প্লাগইনের আচরণের ওপর নির্ভর করে — আসল ডিভাইসে যাচাই দরকার। নোটিফিকেশন ইনবক্সে ঠিকই জমা হয় এবং সেখান থেকে ট্যাপ করলে সঠিক স্ক্রিনে যায়।
3. **অডিও** WebView-র HTML5 অডিও দিয়ে চলে; ব্যাকগ্রাউন্ডে চলা best-effort। নেটিভ foreground service ও লক-স্ক্রিন মিডিয়া কন্ট্রোল **নেই** (এজন্য ইচ্ছা করেই `FOREGROUND_SERVICE` পারমিশন নেওয়া হয়নি)। Android প্রসেস বন্ধ করলে অডিও থামবে।
4. **অফলাইন প্রথম-চালু:** অ্যাপ লাইভ সাইট লোড করে, তাই একদম প্রথমবার ইন্টারনেট লাগে। তারপর Service Worker ক্যাশ থেকে চলে। ক্যাশ/ডেটা মুছলে আবার ইন্টারনেট লাগবে (না থাকলে "সংযোগ নেই" পাতা + আবার চেষ্টা বাটন)।
5. **`allowBackup=false`:** Android অটো-ব্যাকআপ বন্ধ — নতুন ফোনে গেলে ডিভাইস-লোকাল ডেটা (বুকমার্ক, নোট) ফিরে আসবে না। (সাইন-ইন করা অ্যাকাউন্টের ডেটা আসে।) ব্যাকআপ চালু করলে WebView ডেটার ওপর কী ঘটে তা আলাদা করে যাচাই না করে বন্ধ রাখা হয়েছে।
6. ডেইলি রিমাইন্ডার **exact alarm ছাড়া** (inexact, `allowWhileIdle`) — মিনিট-নির্ভুল নয়, কয়েক মিনিট এদিক-ওদিক হতে পারে।
7. `minifyEnabled false` — R8/অবফাসকেশন বন্ধ (APK কিছুটা বড়)। থিমড (monochrome) আইকন নেই।
8. ওয়েবসাইটের "Status" (ব্যবহারকারীর পোস্ট) ফিচার অ্যাপে **নেই** (ইচ্ছাকৃত — UGC মডারেশন/রিপোর্ট সুবিধা ছাড়া Play-নীতির ঝুঁকি)।
9. In-App Update শুধু Google Play থেকে ইনস্টল করা অ্যাপে, এবং ঐচ্ছিক প্লাগইন নামলে কাজ করে।
10. প্রতিটি রানে নতুন debug কী (স্থায়ী কী না দিলে) — §৪.৩।
11. প্রথম আসল CI রানে ছোটখাটো সমস্যা আসতে পারে (প্লাগইনের `@8` ভার্সন, টেমপ্লেটের স্ট্রিং বদল ইত্যাদি) — স্ক্রিপ্ট strict, তাই অস্পষ্টভাবে ভাঙার বদলে স্পষ্ট বার্তা দিয়ে থামে।

---

## ১৩. কোন ফাইল কী করে (বিল্ড-সংক্রান্ত)

| ফাইল | কাজ |
|---|---|
| `.github/workflows/build-apk.yml` | "Build Android app" workflow |
| `android-build/create-project.sh [full\|safe]` | Capacitor প্রজেক্ট তৈরি + প্যাচ (প্লাগইন ইনস্টল সহ) |
| `android-build/apply-native-patches.mjs` | `config` ও `android` ধাপে `capacitor.config.json`, ম্যানিফেস্ট (পারমিশন, ফিল্টার, শর্টকাট, FCM মেটা-ডেটা), Gradle (ভার্সন, signing), আইকন, স্প্ল্যাশ, `google-services.json`, `error.html` প্যাচ |
| `android-build/self-test.mjs` | প্যাচ স্ক্রিপ্টের স্বয়ংক্রিয় পরীক্ষা (workflow-র প্রথম ধাপ) |
| `android-build/preflight.mjs` | repo-র দ্রুত যাচাই |
| `android-build/audit-apk.mjs` | বিল্ডের পর APK অডিট |
| `android-build/res/` | রিসোর্স টেমপ্লেট (শর্টকাট, নোটিফিকেশন আইকন, স্ট্রিং বাংলা/ইংরেজি, রং) |
| `scripts/send-prayer-notifications.js` | ওয়াক্তের পুশ (Android পে-লোড যোগ হয়েছে) |

`create-project.sh safe` / `QR_PATCH_LENIENT=1` শুধু জরুরি ফলব্যাকের জন্য — স্বাভাবিক বিল্ডে strict মোড চলে।
