# Android অ্যাপের Lottie Launch Splash

কুরআন বাংলা **Android অ্যাপ** চালু হলে আপনার নিজের `quran-bangla-splash.json` অ্যানিমেশনটা (লোগো আঁকা → সবুজ রঙে ভরা → "Quran Bangla" লেখা) সাদা পূর্ণ-স্ক্রিনে একবার চলে। অ্যাপ ততক্ষণে পেছনে চালু হতে থাকে। **সাধারণ ওয়েবসাইটে এর কিছুই লোড হয় না, তৈরিও হয় না।**

## ১. Lottie runtime বসানো (নিজে নিজে হয়)

অ্যানিমেশন চালানোর library (`lottie-web`, অফিসিয়াল SVG player) তৃতীয় পক্ষের CDN থেকে নয়, আপনার নিজের সাইট থেকেই লোড হয়। তাই ফাইলটা রিপোজিটরিতে থাকতে হবে:

```
assets/vendor/lottie/lottie_svg.min.js   ← lottie-web 5.12.2 (অফিসিয়াল npm প্যাকেজ থেকে, অপরিবর্তিত)
assets/vendor/lottie/LICENSE.md          ← lottie-web এর লাইসেন্স (MIT)
assets/vendor/lottie/VERSION.json        ← ভার্সন + sha256 (preflight এটা মিলিয়ে দেখে)
```

**আলাদা কিছু করতে হয় না।** `android-build/vendor-lottie.mjs` ও `.github/workflows/vendor-lottie.yml` push করলেই GitHub Actions এর **Vendor Lottie runtime** workflow নিজে চালু হয়: npm থেকে pinned ভার্সন নামায়, যাচাই করে, উপরের তিনটি ফাইল commit করে দেয় (Vercel তখন আবার deploy করে)। আবার চালালে নতুন কিছু বদলায় না, তাই লুপও হয় না।

হাতে চালাতে চাইলে: GitHub → **Actions** → **Vendor Lottie runtime** → **Run workflow**, অথবা নিজের কম্পিউটারে `node android-build/vendor-lottie.mjs` তারপর `assets/vendor/lottie/` commit করুন।

> **ফাইলটা না থাকলে কী হয়?** অ্যাপ ভাঙে না — অ্যানিমেশনের বদলে সাদা পর্দায় অ্যাপের আইকন (`icons/icon-512.png`) দেখায়, তারপর অ্যাপ খোলে। `android-build/preflight.mjs` তখন একটা সতর্কবার্তা (warning) দেয়, build ব্যর্থ হয় না।

## ২. স্টার্টআপ ক্রম

| ধাপ | কী ঘটে |
|---|---|
| ১. Native launch | আগের মতোই native splash চলে, WebView লোড হয় |
| ২. Lottie প্রস্তুতি | `js/platform.js` সবার আগে `app/js/splash.js` চালু করে; সাদা overlay তৈরি হয়; runtime ও JSON **সমান্তরালে** লোড হয় |
| ৩. প্রথম ফ্রেম | lottie-web প্রথম ফ্রেম আঁকে → স্ক্রিনে পৌঁছালে native splash সরে যায় (`SplashScreen.hide`) |
| ৪. চলা | native splash মিলিয়ে যাওয়ার পর (≈০.২৪ সেকেন্ড) অ্যানিমেশন **১.০x গতিতে একবার** চলে; অ্যাপ পেছনে চালু হতে থাকে |
| ৫. সমাপ্তি | **অ্যানিমেশন শেষ হয়েছে এবং অ্যাপ UI প্রস্তুত** — এই দুটো শর্ত পূরণ হলে overlay মিলিয়ে যায়। যেটা পরে শেষ হয়, তার জন্য অপেক্ষা করে |

বাড়তি: অ্যাপ background থেকে ফিরলে বা পর্দা বদলালে অ্যানিমেশন আবার চলে না — শুধু নতুন করে অ্যাপ চালু (নতুন document) হলে চলে।

### কখন দেখায়, অফলাইনে কী হয়

- **প্রতিবার অ্যাপ নতুন করে চালু হলে** দেখায় — অনলাইন বা অফলাইন, প্রথমবার বা পঞ্চাশতমবার। অ্যাপ বন্ধ করে (বা সিস্টেম বন্ধ করে দেওয়ার পর) আবার খুললেই চলে।
- Home চেপে বেরিয়ে আবার ফিরলে (অ্যাপ বন্ধ না হলে) চলে না — অ্যাপ তো তখন চালুই আছে।
- **অফলাইনে**: splash-এর তিনটি ফাইল (`splash.js`, runtime, অ্যানিমেশন JSON) service worker অ্যাপ UI-র ফাইলের মতোই নিজের cache এ রাখে। অ্যাপ চালু হয়ে service worker সক্রিয় হওয়ামাত্র (অ্যাপ idle হওয়ার অপেক্ষা না করে) ফাইলগুলো cache হয়, তাই ছোট একটা অনলাইন সেশনই যথেষ্ট। এরপর ইন্টারনেট ছাড়াই অ্যানিমেশন চলে।
- **ইনস্টলের পর একবার অনলাইনে অ্যাপ খুলতে হবে**: আপনার অ্যাপ লাইভ সাইট (`quranbangla.vercel.app`) থেকে লোড হয়, তাই একেবারে প্রথম চালু অনলাইনে না হলে অ্যাপ নিজেই (splash সহ) খুলতে পারে না — এটা আগের থেকেই এমন।
- অনলাইনে অ্যাপের নতুন সংস্করণ deploy হলে (`SW_VERSION` বাড়লে) cache নতুন করে ভরে — পরের অনলাইন সেশনেই।

## ৩. Native splash ও Lottie splash কীভাবে একসাথে কাজ করে

- `js/platform.js` এ `P.splash.holdsNative = true` থাকাকালীন `P.markReady()` native splash সরায় না।
- `splash.js` প্রথম Lottie ফ্রেম স্ক্রিনে আসার পরেই native splash ছাড়ে (এবং `holdsNative = false` করে)। সেই সময় সিস্টেম বার (status/navigation bar) সাদা হয়; overlay যাওয়ার পর অ্যাপের নিজের রঙ ফিরে আসে (`app/js/native.js` এর ছোট guard — অ্যাপ নিজে মাঝখানে বার বদলাতে পারে না)।
- `platform.js` এর নিজস্ব safety net আছে: `splash.js` লোড না হলে বা ৫ সেকেন্ডে না শুরু হলে hold ছেড়ে দেওয়া হয়; আর ১৬ সেকেন্ড পর overlay জোর করে সরানো হয়।
- আগের সব নিরাপত্তা-ব্যবস্থা অপরিবর্তিত: native `launchShowDuration` ৮ সেকেন্ড, `platform.js` এর ৯ সেকেন্ডের timer, ১২ সেকেন্ডের boot watchdog (ব্যর্থ হলে ওয়েবসাইট UI তে reload)।

## ৪. কিছু ভুল হলে

| পরিস্থিতি | ফল |
|---|---|
| runtime বা JSON নেই / লোড হয়নি | সাদা পর্দায় অ্যাপ আইকন (স্থির), অ্যাপ প্রস্তুত হলে মিলিয়ে যায় |
| ইন্টারনেট ধীর (৪.৫ সেকেন্ডে runtime+JSON আসেনি) | native splash চলতে থাকে; অ্যাপ প্রস্তুত থাকলে সরাসরি অ্যাপ, না হলে স্থির আইকন। দেরিতে আসা runtime উপেক্ষা করা হয় |
| lottie error / প্রথম ফ্রেম আসেনি | একই fallback |
| অ্যানিমেশন "complete" জানায়নি | দৈর্ঘ্য (৩.২s) + ২.৫s পর শেষ ফ্রেমে থামিয়ে ধরা হয় |
| অ্যাপ UI চালু হয়নি | আগের মতোই ১২ সেকেন্ডে watchdog → ওয়েবসাইট UI (splash আর থাকে না) |
| অফলাইনে চালু | service worker cache থেকে চলে (`splash.js` নিজে এবং `boot.js` ফাইলগুলো cache করতে বলে) |

যেকোনো অবস্থায় overlay সর্বোচ্চ ১৪ সেকেন্ড থাকে।

## ৫. ফাইল

**নতুন**
- `assets/animations/quran-bangla-splash.json` — আপনার অ্যানিমেশন, বাইট-বাই-বাইট অপরিবর্তিত
- `app/js/splash.js` — splash নিয়ন্ত্রণ (শুধু অ্যাপে)
- `android-build/vendor-lottie.mjs`, `.github/workflows/vendor-lottie.yml` — runtime বসানোর স্ক্রিপ্ট/workflow
- `tests/splash.test.js`, `tests/ui/splash.ui.test.js`, `tests/ui/splash.real.ui.test.js`, `tests/helpers/splash-harness.js`, `tests/helpers/lottie-runtime-stub.js` — টেস্ট
- `assets/vendor/lottie/*` — (§১ এর কাজের পর)

**পরিবর্তিত**
- `js/platform.js` — অ্যাপ-মোডে splash চালু + native splash hold + safety net (ওয়েবসাইট path অপরিবর্তিত)
- `app/js/boot.js` — offline এর জন্য splash ফাইলও cache করতে বলে
- `app/js/native.js` — splash চলাকালীন সিস্টেম বার না বদলানোর guard
- `js/data.js` — `SW_VERSION` বাড়ানো (platform.js cache-first, তাই নইলে পুরনো কপি থেকে যেত)
- `android-build/preflight.mjs` — splash ফাইল/runtime/লাইসেন্স যাচাই

## ৬. অ্যানিমেশন বদলাতে চাইলে

1. `assets/animations/quran-bangla-splash.json` বদলান।
2. `tests/splash.test.js` এর `ORIGINAL_SHA256` নতুন ফাইলের sha256 দিয়ে হালনাগাদ করুন।
3. `js/data.js` এ `SW_VERSION` বাড়ান (service worker cache-first, নইলে পুরনো অ্যানিমেশন cache থেকে চলবে)।
4. lottie-web এর ভার্সন বদলাতে চাইলে `android-build/vendor-lottie.mjs` এর `VERSION` বদলে workflow আবার চালান।

## ৭. টেস্ট

```bash
npm test                                   # স্ট্যাটিক টেস্ট (দ্রুত, browser লাগে না)
node --test tests/ui/splash.ui.test.js     # আসল অ্যাপ + simulated Android shell, lottie এর নকল দিয়ে (Playwright + Chromium লাগে)
node --test tests/ui/splash.real.ui.test.js  # আসল অ্যাপ + আসল lottie-web: অ্যানিমেশন সত্যিই ঠিকমতো আঁকছে কিনা
node android-build/preflight.mjs           # build এর আগের যাচাই
node android-build/self-test.mjs           # build স্ক্রিপ্ট self-test
```

**আসল lottie-web দিয়ে যাচাই নিজে নিজে হয়:** runtime বসানোর পর **Vendor Lottie runtime** workflow একই run-এ `splash.real.ui.test.js` চালায় (GitHub-এর সার্ভারে, headless Chromium)। এটা পিক্সেল ধরে দেখে: প্রথম ফ্রেম সাদা → লোগো আঁকা → সবুজে ভরা → wordmark ফোটা → শেষ ফ্রেম স্থির; ১x গতি, একবারই চলা, রঙ অপরিবর্তিত, গ্র্যাডিয়েন্ট/glow/shadow নেই, লোগো ও লেখা ঠিক জায়গায় (কেন্দ্রে), আর অফলাইনেও চলে। ফলাফল দেখতে: GitHub → **Actions** → সেই run → ধাপ **Check the real animation…** (সবুজ টিক = পাস)। রেন্ডার হওয়া আসল ফ্রেমের ছবি একই run-এর **Artifacts → `splash-real-frames`** এ থাকে। এই ধাপ fail করলেও runtime commit হয়ে যায় (ধাপটা আলাদা ও non-blocking) — লগ দেখলেই বোঝা যাবে কোথায় তফাত।

`splash.ui.test.js` এ lottie-web এর বদলে `tests/helpers/lottie-runtime-stub.js` (ছোট নকল) ব্যবহার হয় — সেটা প্রমাণ করে splash কখন কী করে (native splash কখন সরে, কীসের জন্য অপেক্ষা করে, ব্যর্থ হলে কী হয়, ওয়েবসাইট অপরিবর্তিত)। **আসল Android ডিভাইসে আসল WebView তে কেমন দেখায়** তা একটা ফোনে নিজে দেখে নিন।

## ৮. ডিভাইসে যাচাই / ডিবাগ

USB debugging চালু করে Chrome এ `chrome://inspect` খুলুন, অ্যাপের WebView ধরুন, console এ:

```js
QR_PLATFORM.splash.info    // { mode: 'lottie' | 'fallback' | 'skipped', startMs, assetsMs, firstFrameMs, playMs, completeMs, leaveMs, reason }
QR_PLATFORM.splash.phase   // 'done' হলে শেষ
```

`mode: 'fallback'` দেখালে `reason` বলে দেবে কেন অ্যানিমেশন চলেনি।

## ৯. সীমাবদ্ধতা

- মূল অ্যানিমেশনের পটভূমি সাদা — অ্যাপ dark mode এ থাকলেও splash সাদাই থাকে (আপনার নকশা অনুযায়ী); শেষে মৃদু fade হয়ে অ্যাপের থিমে যায়।
- native splash এর রঙ (গাঢ় সবুজ) ও Lottie এর সাদা পর্দার মাঝে ০.১৮ সেকেন্ডের fade আছে — native splash অপরিবর্তিত রাখার শর্তে এটা অনিবার্য।
- স্থির আইকন-fallback দেখলে বুঝবেন runtime/অ্যানিমেশন ফাইল সাইটে পৌঁছায়নি (§১ দেখুন)।
