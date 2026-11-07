#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/self-test.mjs  -  checks apply-native-patches.mjs against a hand-made imitation of the project that
// `npx cap add android` generates. Runs in about a second, needs only Node.js, and is the first step of the
// "Build APK" workflow so a broken patch script is reported before any slow download starts.
//
// IMPORTANT: this is an imitation of the Capacitor template written from its documented layout. It catches mistakes in
// the patch logic (bad XML, duplicate permissions, wrong Gradle text, missing resources); it cannot prove that the real
// Capacitor 8 template and Gradle accept the result - only the real build does that.
//
//   node android-build/self-test.mjs
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseBadging, classifyPermissions, parseApksigner, parseManifestTree, assetlinksJson, formatFingerprint, isDebugCertificate, renderMarkdown
} from './audit-apk.mjs';
import {
  checkXml, decodePng, cornerColor, patchManifestText, groovyBlock, ktsBlock, errorPageHtml, placeholderIndexHtml,
  findUnresolvedRefs, PERMISSIONS_ADD, PERMISSIONS_REMOVE, MARK, userAgentToken, FCM_FLAG, summaryMarkdown
} from './apply-native-patches.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'apply-native-patches.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-selftest-'));
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(name + (detail ? ' -> ' + detail : ''));
}
function eq(name, a, b) { check(name, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);
const count = (s, sub) => s.split(sub).length - 1;

// ------------------------------------------------------------------------------------------------ fixture builders
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
// RGBA PNG; pixel(x, y) -> [r, g, b, a]; filter type alternates so the decoder's filters are exercised
function makePng(w, h, pixel, filters = [0, 1, 2, 3, 4]) {
  const rows = [];
  const prevRaw = [];
  for (let y = 0; y < h; y++) {
    const raw = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) { const p = pixel(x, y); raw[x * 4] = p[0]; raw[x * 4 + 1] = p[1]; raw[x * 4 + 2] = p[2]; raw[x * 4 + 3] = p[3]; }
    const ft = filters[y % filters.length];
    const out = Buffer.alloc(w * 4 + 1);
    out[0] = ft;
    const prev = y > 0 ? prevRaw[y - 1] : null;
    for (let x = 0; x < w * 4; x++) {
      const a = x >= 4 ? raw[x - 4] : 0, b = prev ? prev[x] : 0, c = prev && x >= 4 ? prev[x - 4] : 0;
      let pred = 0;
      if (ft === 1) pred = a; else if (ft === 2) pred = b; else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x + 1] = (raw[x] - pred) & 255;
    }
    prevRaw.push(raw);
    rows.push(out);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), pngChunk('IEND', Buffer.alloc(0))]);
}
const GREEN = [20, 64, 22, 255];

const MANIFEST_STANDARD = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- Permissions -->

    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;
const GRADLE_GROOVY = `apply plugin: 'com.android.application'

android {
    namespace = "com.techverse.quranbangla"
    compileSdk = rootProject.ext.compileSdkVersion
    defaultConfig {
        applicationId "com.techverse.quranbangla"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
        aaptOptions {
             // Files and dirs to omit from the packaged assets dir, modified to accommodate modern web apps.
            ignoreAssetsPattern = '!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~'
        }
    }
    buildTypes {
        release {
            minifyEnabled false
            proguardFiles getDefaultProguardFile('proguard-android.txt'), 'proguard-rules.pro'
        }
    }
}

repositories {
    flatDir{
        dirs '../capacitor-cordova-android-plugins/src/main/libs', 'libs'
    }
}

dependencies {
    implementation fileTree(include: ['*.jar'], dir: 'libs')
    implementation "androidx.appcompat:appcompat:$androidxAppCompatVersion"
    implementation project(':capacitor-android')
    implementation project(':capacitor-cordova-android-plugins')
}

apply from: 'capacitor.build.gradle'

try {
    def servicesJSON = file('google-services.json')
    if (servicesJSON.text) {
        apply plugin: 'com.google.gms.google-services'
    }
} catch(Exception e) {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}
`;
const GRADLE_KTS = `plugins { id("com.android.application") }

android {
    namespace = "com.techverse.quranbangla"
    defaultConfig {
        applicationId = "com.techverse.quranbangla"
        versionCode = 1
        versionName = "1.0"
    }
}
`;
const VARIABLES_GRADLE = `ext {
    minSdkVersion = 24
    compileSdkVersion = 36
    targetSdkVersion = 36
    androidxAppCompatVersion = '1.7.1'
    coreSplashScreenVersion = '1.2.0'
}
`;
const ROOT_GRADLE = `buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath 'com.android.tools.build:gradle:8.13.0'
        classpath 'com.google.gms:google-services:4.4.4'
    }
}
apply from: "variables.gradle"
`;
const STYLES = `<?xml version="1.0" encoding="utf-8" ?>
<resources>

    <!-- Base application theme. -->
    <style name="AppTheme" parent="Theme.AppCompat.DayNight.DarkActionBar">
        <item name="colorPrimary">@color/colorPrimary</item>
    </style>

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">
        <item name="windowActionBar">false</item>
        <item name="windowNoTitle">true</item>
        <item name="android:background">@null</item>
    </style>

    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">@drawable/splash</item>
    </style>
</resources>
`;
const ADAPTIVE_OLD = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;

function makeProject(name, opts = {}) {
  const root = path.join(TMP, name);
  const app = path.join(root, 'android', 'app');
  const main = path.join(app, 'src', 'main');
  const res = path.join(main, 'res');
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  let manifest = opts.manifest || MANIFEST_STANDARD;
  if (opts.crlf) manifest = manifest.replace(/\n/g, '\r\n');
  put(path.join(main, 'AndroidManifest.xml'), manifest);
  if (opts.kts) put(path.join(app, 'build.gradle.kts'), GRADLE_KTS); else put(path.join(app, 'build.gradle'), opts.gradle || GRADLE_GROOVY);
  put(path.join(root, 'android', 'variables.gradle'), opts.variables || VARIABLES_GRADLE);
  put(path.join(root, 'android', 'build.gradle'), opts.rootGradle || ROOT_GRADLE);
  // the config phase writes <project>/capacitor.config.json and `cap add android` copies it into the Android assets
  const capConfig = JSON.stringify({ appId: 'com.techverse.quranbangla', appName: 'Quran Bangla', webDir: 'www', server: { url: 'https://quranbangla.vercel.app' }, android: { appendUserAgent: userAgentToken('1.1.0', '123') }, plugins: {} }, null, 2) + '\n';
  put(path.join(root, 'capacitor.config.json'), capConfig);
  if (!opts.noAssetsConfig) put(path.join(main, 'assets', 'capacitor.config.json'), capConfig);
  if (!opts.noStyles) put(path.join(res, 'values', 'styles.xml'), opts.styles || STYLES);
  put(path.join(res, 'values', 'strings.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="app_name">Quran Bangla</string>\n    <string name="title_activity_main">Quran Bangla</string>\n</resources>\n');
  put(path.join(res, 'values', 'ic_launcher_background.xml'), '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#FFFFFF</color>\n</resources>\n');
  put(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), ADAPTIVE_OLD);
  put(path.join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), ADAPTIVE_OLD);
  const dummy = makePng(4, 4, () => [255, 255, 255, 255]);
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const f of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      fs.mkdirSync(path.join(res, 'mipmap-' + d), { recursive: true });
      fs.writeFileSync(path.join(res, 'mipmap-' + d, f), dummy);
    }
  }
  return root;
}

function envFor(extra = {}) {
  const e = { PATH: process.env.PATH, APP_ID: 'com.techverse.quranbangla', APP_NAME: 'Quran Bangla', APP_VERSION: '1.1.0', APP_VERSION_CODE: '123', LIVE_URL: 'https://quranbangla.vercel.app' };
  return Object.assign(e, extra);
}
function run(phase, project, { mode = 'full', repo = REPO, env = {}, args = [] } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, phase, '--mode', mode, '--project', project, '--repo', repo, ...args], { env: envFor(env), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function xmllint(file) {
  const r = spawnSync('xmllint', ['--noout', file], { encoding: 'utf8' });
  if (r.error) return null; // xmllint not installed
  return r.status === 0 ? '' : r.stderr;
}

// ------------------------------------------------------------------------------------------------------ 1. checkXml
{
  eq('checkXml accepts the Capacitor manifest', checkXml(MANIFEST_STANDARD), null);
  check('checkXml: unclosed tag', checkXml('<a><b></a>') !== null);
  check('checkXml: mismatched tag', checkXml('<a></b>') !== null);
  check('checkXml: duplicate attribute', /duplicate/.test(checkXml('<a x="1" x="2"/>') || ''));
  check('checkXml: bare ampersand', checkXml('<a>fish & chips</a>') !== null);
  eq('checkXml: escaped ampersand', checkXml('<a b="x &amp; y">&lt;ok&gt;</a>'), null);
  check('checkXml: two roots', checkXml('<a/><b/>') !== null);
  check('checkXml: unterminated comment', checkXml('<a><!-- x</a>') !== null);
  check('checkXml: double hyphen in comment', checkXml('<a><!-- a -- b --></a>') !== null);
  check('checkXml: unquoted attribute', checkXml('<a b=1/>') !== null);
  eq('checkXml: CDATA + PI', checkXml('<?xml version="1.0"?><a><![CDATA[<x>&]]></a>'), null);
}

// -------------------------------------------------------------------------------------------------------- 2. PNG
{
  const png = makePng(40, 40, (x, y) => (x < 8 && y < 8) || (x > 31 && y < 8) || (x < 8 && y > 31) || (x > 31 && y > 31) ? GREEN : [200, 200, 0, 255]);
  const d = decodePng(png);
  eq('decodePng width', d.width, 40);
  eq('decodePng corner pixel', Array.from(d.data.subarray(0, 4)).join(','), GREEN.join(','));
  eq('decodePng centre pixel', Array.from(d.data.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 4)).join(','), '200,200,0,255');
  eq('cornerColor', cornerColor(d), '#144016');
  check('decodePng rejects garbage', (() => { try { decodePng(Buffer.from('nope')); return false; } catch (e) { return true; } })());
  // the real maskable icon of the project
  const real = path.join(REPO, 'icons', 'icon-512-maskable.png');
  if (exists(real)) {
    const c = cornerColor(decodePng(fs.readFileSync(real)));
    check('real maskable icon corner colour is a hex colour', /^#[0-9A-F]{6}$/.test(c), c);
  }
}

// ----------------------------------------------------------------------------------------- 3. patchManifestText (pure)
{
  const r = patchManifestText(MANIFEST_STANDARD, { host: 'quranbangla.vercel.app' });
  const t = r.text;
  eq('manifest well-formed', checkXml(t), null);
  check('manifest marker', t.includes(MARK));
  check('tools namespace added once', count(t, 'xmlns:tools=') === 1);
  for (const p of PERMISSIONS_ADD) eq('permission once: ' + p, count(t, '"' + p + '"'), 1);
  for (const p of PERMISSIONS_REMOVE) check('permission blocked: ' + p, t.includes('"' + p + '" tools:node="remove"'));
  eq('INTERNET not duplicated', count(t, 'android.permission.INTERNET'), 1);
  check('allowBackup false', /android:allowBackup="false"/.test(t) && !/android:allowBackup="true"/.test(t));
  check('tools:replace allowBackup', /tools:replace="android:allowBackup"/.test(t));
  check('app link filter', t.includes('<intent-filter android:autoVerify="true">') && t.includes('android:host="quranbangla.vercel.app" android:path="/"') && t.includes('android:path="/index.html"'));
  check('custom scheme filter', t.includes('<data android:scheme="quranbangla" />'));
  check('shortcuts meta', t.includes('android:name="android.app.shortcuts" android:resource="@xml/shortcuts"'));
  for (const n of ['default_notification_icon', 'default_notification_color', 'default_notification_channel_id']) check('fcm meta ' + n, t.includes('com.google.firebase.messaging.' + n));
  check('launcher activity keeps launchMode + exported', /android:launchMode="singleTask"/.test(t) && /android:exported="true"/.test(t));
  check('autoVerify filter has no custom scheme', !/autoVerify[\s\S]{0,400}scheme="quranbangla"[\s\S]{0,40}<\/intent-filter>/.test(t.split('</intent-filter>')[1] || ''));
  check('provider untouched', t.includes('androidx.core.content.FileProvider') && t.includes('${applicationId}.fileprovider'));
  const again = patchManifestText(t, { host: 'quranbangla.vercel.app' });
  check('manifest patch is idempotent', again.changed === false && again.text === t);
  const lx = xmllint; // eslint-disable-line no-unused-vars
  // existing permissions are never declared twice
  const pre = MANIFEST_STANDARD.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.VIBRATE" />\n    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />');
  const r2 = patchManifestText(pre, { host: 'quranbangla.vercel.app' });
  eq('VIBRATE not duplicated', count(r2.text, 'android.permission.VIBRATE'), 1);
  eq('ACCESS_NETWORK_STATE not duplicated', count(r2.text, 'android.permission.ACCESS_NETWORK_STATE'), 1);
  eq('r2 well-formed', checkXml(r2.text), null);
  // a forbidden permission already written into the generated manifest becomes a removal marker (no duplicate element)
  const bad = MANIFEST_STANDARD.replace('<uses-permission android:name="android.permission.INTERNET" />',
    '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />');
  const r3 = patchManifestText(bad, { host: 'quranbangla.vercel.app' });
  eq('forbidden permission appears once', count(r3.text, 'android.permission.WRITE_EXTERNAL_STORAGE'), 1);
  check('forbidden permission is marked remove', /WRITE_EXTERNAL_STORAGE" tools:node="remove"/.test(r3.text));
  eq('r3 well-formed', checkXml(r3.text), null);
  // tools already declared, activity without launchMode/exported, CRLF
  const odd = MANIFEST_STANDARD.replace('<manifest xmlns:android="http://schemas.android.com/apk/res/android">', '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools" package="com.techverse.quranbangla">')
    .replace('android:launchMode="singleTask"\n            android:exported="true">', '>').replace(/\n/g, '\r\n');
  const r4 = patchManifestText(odd, { host: 'quranbangla.vercel.app' });
  eq('xmlns:tools not duplicated', count(r4.text, 'xmlns:tools='), 1);
  check('launchMode added', /android:launchMode="singleTask"/.test(r4.text));
  check('exported added', /android:exported="true"/.test(r4.text));
  eq('r4 well-formed', checkXml(r4.text), null);
  check('manifest without launcher activity is rejected', (() => { try { patchManifestText(MANIFEST_STANDARD.replace('android.intent.category.LAUNCHER', 'android.intent.category.INFO'), { host: 'a.b' }); return false; } catch (e) { return /launcher activity/.test(e.message); } })());
  check('invalid host is rejected', (() => { try { patchManifestText(MANIFEST_STANDARD, { host: 'a b"><x' }); return false; } catch (e) { return /host/.test(e.message); } })());
}

// ------------------------------------------------------------------------------------------ 4. config phase (full / safe)
{
  const full = path.join(TMP, 'cfg-full');
  const r = run('config', full);
  eq('config full exit code', r.code, 0, r.out);
  const cfg = JSON.parse(read(path.join(full, 'capacitor.config.json')));
  eq('cfg appId', cfg.appId, 'com.techverse.quranbangla');
  eq('cfg server.url', cfg.server.url, 'https://quranbangla.vercel.app');
  eq('cfg errorPath', cfg.server.errorPath, 'error.html');
  eq('cfg cleartext off', cfg.server.cleartext, false);
  eq('cfg user agent token', cfg.android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('cfg insets', cfg.plugins.SystemBars.insetsHandling, 'disable');
  eq('cfg system bars style (dark theme)', cfg.plugins.SystemBars.style, 'DARK');
  eq('cfg edge-to-edge colour', cfg.plugins.EdgeToEdge.backgroundColor, '#092723');
  eq('cfg splash autohide', cfg.plugins.SplashScreen.launchAutoHide, true);
  eq('cfg splash resource', cfg.plugins.SplashScreen.androidSplashResourceName, 'qr_splash');
  eq('cfg notification icon', cfg.plugins.LocalNotifications.smallIcon, 'ic_stat_quran');
  check('www/index.html exists', exists(path.join(full, 'www', 'index.html')));
  const errHtml = read(path.join(full, 'www', 'error.html'));
  check('error.html has retry button', errHtml.includes('id="retry"'));
  const inline = /<script>([\s\S]*?)<\/script>/.exec(errHtml);
  check('error.html script compiles', (() => { try { new Function(inline[1]); return true; } catch (e) { return false; } })());
  check('error.html embeds the live URL', errHtml.includes('"https://quranbangla.vercel.app"'));
  const safe = path.join(TMP, 'cfg-safe');
  const rs = run('config', safe, { mode: 'safe' });
  eq('config safe exit code', rs.code, 0);
  const cs = JSON.parse(read(path.join(safe, 'capacitor.config.json')));
  check('safe config has no errorPath / splash / notification plugin keys', !cs.server.errorPath && !cs.plugins.SplashScreen && !cs.plugins.LocalNotifications);
  check('safe config keeps live url + edge-to-edge', cs.server.url === 'https://quranbangla.vercel.app' && cs.plugins.EdgeToEdge.backgroundColor === '#092723');
  check('safe mode writes no error.html', !exists(path.join(safe, 'www', 'error.html')));
  // hostile URL can never break out of the inline script
  const html = errorPageHtml({ liveUrl: 'https://x.test/</script><script>alert(1)</script>', appName: 'A<B>"' });
  check('error page escapes </script>', !html.includes('</script><script>alert'));
  check('placeholder escapes app name', placeholderIndexHtml({ liveUrl: 'https://x.test', appName: '<b>' }).includes('&lt;b&gt;'));
  // settings validation
  for (const [label, env] of [
    ['APP_ID invalid', { APP_ID: 'not an id' }], ['APP_ID single segment', { APP_ID: 'quran' }], ['version code text', { APP_VERSION_CODE: 'abc' }],
    ['version code zero', { APP_VERSION_CODE: '0' }], ['version code huge', { APP_VERSION_CODE: '2200000000' }], ['version name quote', { APP_VERSION: '1.0"; evil' }],
    ['http live url', { LIVE_URL: 'http://quranbangla.vercel.app' }], ['empty live url', { LIVE_URL: '' }], ['empty app name', { APP_NAME: '' }]
  ]) {
    const rr = run('config', path.join(TMP, 'cfg-bad'), { env });
    check('rejects: ' + label, rr.code === 1 && /ERROR/.test(rr.out), rr.out);
  }
}

// ------------------------------------------------------------------------------------------------ 5. android phase full
{
  const proj = makeProject('full');
  const r = run('android', proj, { env: { GOOGLE_SERVICES_JSON: '' } });
  eq('android full exit code', r.code, 0, r.out);
  check('android full warns about missing google-services', /GOOGLE_SERVICES_JSON secret is not set/.test(r.out));
  const manifestFile = path.join(proj, 'android/app/src/main/AndroidManifest.xml');
  const manifest = read(manifestFile);
  eq('manifest well-formed (file)', checkXml(manifest), null);
  const lint = xmllint(manifestFile);
  check('xmllint accepts the manifest', lint === null || lint === '', lint);
  check('manifest has no CRLF', !manifest.includes('\r'));
  check('manifest permissions present', PERMISSIONS_ADD.every((p) => manifest.includes(p)));
  const gradle = read(path.join(proj, 'android/app/build.gradle'));
  check('gradle block present once', count(gradle, MARK) === 1);
  check('gradle versionCode', gradle.includes('versionCode = 123') && gradle.includes('versionName = "1.1.0"'));
  check('gradle signing from env', gradle.includes("System.getenv('QR_KEYSTORE_PATH')") && gradle.includes("signingConfigs.getByName('qrRelease')"));
  check('gradle: original google-services block untouched', gradle.includes("apply plugin: 'com.google.gms.google-services'") && gradle.includes('apply from: \'capacitor.build.gradle\''));
  check('gradle: no secrets or paths written', !/password\s*=\s*['"][^'"]+['"]/i.test(gradle));
  const res = path.join(proj, 'android/app/src/main/res');
  const shortcuts = read(path.join(res, 'xml/shortcuts.xml'));
  check('shortcuts: app id substituted', !shortcuts.includes('__APP_ID__') && shortcuts.includes('android:targetClass="com.techverse.quranbangla.MainActivity"'));
  eq('shortcuts well-formed', checkXml(shortcuts), null);
  for (const f of ['drawable/ic_stat_quran.xml', 'drawable/ic_shortcut_continue.xml', 'drawable/ic_shortcut_search.xml', 'drawable/ic_shortcut_prayer.xml', 'drawable/ic_shortcut_qibla.xml', 'values/qr_strings.xml', 'values-bn/qr_strings.xml', 'values/qr_colors.xml']) check('resource copied: ' + f, exists(path.join(res, f)));
  const theme = read(path.join(res, 'values/qr_theme.xml'));
  check('theme colours', theme.includes('name="qr_splash_background">#092723<') && /name="qr_icon_background">#[0-9A-F]{6}</.test(theme));
  eq('theme well-formed', checkXml(theme), null);
  const adaptive = read(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'));
  check('adaptive icon written', adaptive.includes('@color/qr_icon_background') && adaptive.includes('@drawable/qr_icon_foreground_inset'));
  check('round icon equals adaptive icon', adaptive === read(path.join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml')));
  check('foreground png copied', exists(path.join(res, 'drawable-nodpi/qr_icon_foreground.png')) && exists(path.join(res, 'drawable-nodpi/qr_splash_icon.png')));
  check('splash drawable written', exists(path.join(res, 'drawable/qr_splash.xml')));
  const legacy = fs.readFileSync(path.join(res, 'mipmap-xxxhdpi/ic_launcher.png'));
  check('legacy launcher PNG replaced by the project icon', legacy.length > 1000, String(legacy.length));
  const styles = read(path.join(res, 'values/styles.xml'));
  check('splash theme patched once', count(styles, 'windowSplashScreenBackground') === 1 && styles.includes('@color/qr_splash_background'));
  eq('styles well-formed', checkXml(styles), null);
  for (const f of ['drawable/qr_icon_foreground_inset.xml', 'drawable/qr_splash.xml', 'mipmap-anydpi-v26/ic_launcher.xml']) eq('well-formed ' + f, checkXml(read(path.join(res, f))), null);
  check('no unresolved references in files created by the script', findUnresolvedRefs([manifestFile, path.join(res, 'xml/shortcuts.xml'), path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), path.join(res, 'drawable/qr_splash.xml'), path.join(res, 'drawable/qr_icon_foreground_inset.xml')], res).filter((x) => /qr_|ic_stat|ic_shortcut|shortcuts/.test(x)).length === 0);
  check('report written', exists(path.join(proj, 'qr-patch-report.android.json')));
  // without a Firebase configuration the app must NOT be told that push is available (register() would crash it)
  const noFcmCfg = JSON.parse(read(path.join(proj, 'android/app/src/main/assets/capacitor.config.json')));
  eq('no secret -> user agent has no fcm flag', noFcmCfg.android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  const noFcmReport = JSON.parse(read(path.join(proj, 'qr-patch-report.android.json')));
  check('no secret -> report says fcm is off', noFcmReport.fcm === false && !noFcmReport.fcmFlag);
  check('no secret -> summary says push is NOT enabled', /Push notifications \(Firebase Cloud Messaging\): \*\*NOT enabled/.test(summaryMarkdown(noFcmReport)));
  // second run changes nothing
  const snapshot = [manifestFile, path.join(proj, 'android/app/build.gradle'), path.join(res, 'values/styles.xml')].map(read);
  const r2 = run('android', proj, { env: { GOOGLE_SERVICES_JSON: '' } });
  eq('android full second run exit code', r2.code, 0, r2.out);
  const after = [manifestFile, path.join(proj, 'android/app/build.gradle'), path.join(res, 'values/styles.xml')].map(read);
  check('android patches are idempotent', snapshot.every((s, i) => s === after[i]));
}

// ---------------------------------------------------------------------------------------- 6. google-services.json handling
{
  const fake = (pkg, project = 'quranfreeapps') => JSON.stringify({ project_info: { project_number: '421704127278', project_id: project }, client: [{ client_info: { mobilesdk_app_id: '1:421704127278:android:abc', android_client_info: { package_name: pkg } }, api_key: [{ current_key: 'AIzaFAKEFAKEFAKE' }] }], configuration_version: '1' });
  const a = makeProject('gs-raw');
  const ra = run('android', a, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('raw google-services exit', ra.code, 0, ra.out);
  check('raw google-services written', exists(path.join(a, 'android/app/google-services.json')));
  check('secret value is never printed', !ra.out.includes('AIzaFAKE'));
  const b = makeProject('gs-b64');
  const rb = run('android', b, { env: { GOOGLE_SERVICES_JSON: Buffer.from(fake('com.techverse.quranbangla')).toString('base64') } });
  eq('base64 google-services exit', rb.code, 0, rb.out);
  check('base64 google-services decoded', /"project_id": "quranfreeapps"/.test(read(path.join(b, 'android/app/google-services.json'))));
  const c = makeProject('gs-wrongpkg');
  const rc = run('android', c, { env: { GOOGLE_SERVICES_JSON: fake('com.other.app') } });
  check('wrong package is rejected', rc.code === 1 && /no Android app with package name/.test(rc.out), rc.out);
  const d = makeProject('gs-badjson');
  const rd = run('android', d, { env: { GOOGLE_SERVICES_JSON: 'this is not json' } });
  check('garbage secret is rejected', rd.code === 1 && /neither valid JSON nor base64/.test(rd.out), rd.out);
  const e = makeProject('gs-otherproject');
  const re = run('android', e, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla', 'some-other-project') } });
  check('other Firebase project only warns', re.code === 0 && /website uses "quranfreeapps"/.test(re.out), re.out);
  const f = makeProject('gs-lenient');
  const rf = run('android', f, { env: { GOOGLE_SERVICES_JSON: 'garbage', QR_PATCH_LENIENT: '1' } });
  check('lenient mode turns a bad optional step into a warning', rf.code === 0 && /skipped \(QR_PATCH_LENIENT=1\)/.test(rf.out), rf.out);

  // ---- the "fcm" capability flag in the user agent (producer: patch script, consumer: app/js/native.js) ----
  const cfgOf = (proj, where) => JSON.parse(read(where === 'assets' ? path.join(proj, 'android/app/src/main/assets/capacitor.config.json') : path.join(proj, 'capacitor.config.json')));
  eq('userAgentToken without flags', userAgentToken('1.1.0', 5), 'QuranBanglaApp/1.1.0 (5)');
  eq('userAgentToken with the fcm flag', userAgentToken('1.1.0', 5, [FCM_FLAG]), 'QuranBanglaApp/1.1.0 (5; fcm)');
  eq('valid secret -> assets config carries the fcm flag', cfgOf(a, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  eq('valid secret -> project config carries the fcm flag', cfgOf(a, 'project').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  eq('base64 secret -> fcm flag too', cfgOf(b, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123; fcm)');
  check('the rest of the Capacitor config is untouched by the flag', (() => { const c = cfgOf(a, 'assets'); return c.server.url === 'https://quranbangla.vercel.app' && c.appId === 'com.techverse.quranbangla'; })());
  const flagReport = JSON.parse(read(path.join(a, 'qr-patch-report.android.json')));
  check('report: fcm + fcmFlag true', flagReport.fcm === true && flagReport.fcmFlag === true);
  check('summary says push is enabled', /Push notifications \(Firebase Cloud Messaging\): \*\*enabled in this build\*\*/.test(summaryMarkdown(flagReport)));
  const before2 = [read(path.join(a, 'android/app/src/main/assets/capacitor.config.json')), read(path.join(a, 'android/app/build.gradle'))];
  const ra2 = run('android', a, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('second run with the secret: exit code', ra2.code, 0, ra2.out);
  check('second run with the secret changes nothing', before2[0] === read(path.join(a, 'android/app/src/main/assets/capacitor.config.json')) && before2[1] === read(path.join(a, 'android/app/build.gradle')));
  eq('wrong package -> no flag', cfgOf(c, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('garbage secret -> no flag', cfgOf(d, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  eq('lenient + garbage secret -> no flag', cfgOf(f, 'assets').android.appendUserAgent, 'QuranBanglaApp/1.1.0 (123)');
  // valid secret but the Android assets config is missing: the build must fail instead of shipping an app that cannot use push
  const g = makeProject('gs-noassets', { noAssetsConfig: true });
  const rg = run('android', g, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  check('missing assets config + secret fails the build', rg.code === 1 && /capacitor\.config\.json not found/.test(rg.out), rg.out);
  // valid secret but no Google services Gradle plugin anywhere: Firebase would never start -> error, not a warning
  const hGradle = GRADLE_GROOVY.replace(/try \{[\s\S]*?\n\}\n$/, '');
  const hRoot = ROOT_GRADLE.replace("        classpath 'com.google.gms:google-services:4.4.4'\n", '');
  const hh = makeProject('gs-noplugin', { gradle: hGradle, rootGradle: hRoot });
  check('fixture really has no google-services plugin', !/google-services/.test(read(path.join(hh, 'android/app/build.gradle'))) && !/google-services/.test(read(path.join(hh, 'android/build.gradle'))));
  const rh = run('android', hh, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  check('secret without the Gradle plugin is an error', rh.code === 1 && /Google services Gradle plugin/.test(rh.out), rh.out);
  // plugin missing from the app module only (classpath present): the script applies it
  const iGradle = GRADLE_GROOVY.replace(/try \{[\s\S]*?\n\}\n$/, '');
  const ii = makeProject('gs-applyplugin', { gradle: iGradle });
  const ri = run('android', ii, { env: { GOOGLE_SERVICES_JSON: fake('com.techverse.quranbangla') } });
  eq('plugin applied by the script: exit code', ri.code, 0, ri.out);
  check('plugin applied by the script: line appended once', count(read(path.join(ii, 'android/app/build.gradle')), "apply plugin: 'com.google.gms.google-services'") === 1);
  // the consumer: app/js/native.js must parse exactly this token format
  const nativeSrc = read(path.join(REPO, 'app/js/native.js'));
  const reSrc = /var m = (\/QuranBanglaApp[^\n]*?\/)\.exec\(navigator\.userAgent/.exec(nativeSrc);
  check('native.js has the user-agent regex', !!reSrc);
  if (reSrc) {
    const re = new Function('return ' + reSrc[1])();
    const t1 = re.exec('Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36 QuranBanglaApp/1.1.0 (123; fcm)');
    check('native.js parses the flagged token', !!t1 && t1[1] === '1.1.0' && t1[2] === '123' && /\bfcm\b/.test(t1[3] || ''));
    const t2 = re.exec('Mozilla/5.0 QuranBanglaApp/1.1.0 (123)');
    check('native.js parses the plain token', !!t2 && t2[1] === '1.1.0' && t2[2] === '123' && !t2[3]);
    const t3 = re.exec('Mozilla/5.0 QuranBanglaApp/1.1.0');
    check('native.js parses a token without a build code', !!t3 && t3[1] === '1.1.0' && !t3[2]);
  }
}

// ---------------------------------------------------------------------------------------------------- 7. safe mode
{
  const proj = makeProject('safe');
  const before = read(path.join(proj, 'android/app/src/main/AndroidManifest.xml'));
  const r = run('android', proj, { mode: 'safe' });
  eq('android safe exit code', r.code, 0, r.out);
  eq('safe mode leaves the manifest alone', read(path.join(proj, 'android/app/src/main/AndroidManifest.xml')), before);
  const gradle = read(path.join(proj, 'android/app/build.gradle'));
  check('safe mode still sets version + signing', gradle.includes('versionCode = 123') && gradle.includes('qrRelease'));
  const res = path.join(proj, 'android/app/src/main/res');
  check('safe mode removes adaptive definitions like the old workflow', !exists(path.join(res, 'mipmap-anydpi-v26/ic_launcher.xml')));
  check('safe mode copies no extra resources', !exists(path.join(res, 'xml/shortcuts.xml')) && !exists(path.join(res, 'values/qr_theme.xml')));
  check('safe mode does not touch the splash theme', !read(path.join(res, 'values/styles.xml')).includes('windowSplashScreenBackground'));
}

// ------------------------------------------------------------------------------------------ 8. template variations
{
  const k = makeProject('kts', { kts: true });
  const rk = run('android', k);
  eq('kts template exit code', rk.code, 0, rk.out);
  const kt = read(path.join(k, 'android/app/build.gradle.kts'));
  check('kts block written', kt.includes('versionCode = 123') && kt.includes('create("qrRelease")') && kt.includes('System.getenv("QR_KEYSTORE_PATH")'));
  const ns = makeProject('nostyles', { noStyles: true });
  const rn = run('android', ns);
  eq('missing styles.xml is tolerated', rn.code, 0, rn.out);
  const cr = makeProject('crlf', { crlf: true });
  const rcr = run('android', cr);
  eq('CRLF manifest exit code', rcr.code, 0, rcr.out);
  check('CRLF manifest becomes well-formed LF text', !read(path.join(cr, 'android/app/src/main/AndroidManifest.xml')).includes('\r'));
  const other = makeProject('otherstyles', { styles: STYLES.replace('parent="Theme.SplashScreen"', 'parent="Theme.AppCompat.Light.NoActionBar"') });
  const ro = run('android', other);
  eq('non-SplashScreen launch theme is left alone', ro.code, 0, ro.out);
  check('non-SplashScreen launch theme not modified', !read(path.join(other, 'android/app/res/../src/main/res/values/styles.xml')).includes('windowSplashScreenBackground'));
  const low = makeProject('lowsdk', { variables: VARIABLES_GRADLE.replace('targetSdkVersion = 36', 'targetSdkVersion = 33') });
  const rl = run('android', low);
  check('low targetSdk only warns', rl.code === 0 && /targetSdkVersion is 33/.test(rl.out), rl.out);
  const empty = path.join(TMP, 'empty-project');
  fs.mkdirSync(empty, { recursive: true });
  const re = run('android', empty);
  check('missing generated project gives a clear error', re.code === 1 && /npx cap add android/.test(re.out), re.out);
  const nogradle = makeProject('nogradle');
  fs.unlinkSync(path.join(nogradle, 'android/app/build.gradle'));
  const rng = run('android', nogradle);
  check('missing gradle file stops the build', rng.code === 1 && /build\.gradle/.test(rng.out), rng.out);
}

// -------------------------------------------------------------------- 9. repository without a maskable icon / manifest
{
  const repo = path.join(TMP, 'mini-repo');
  fs.mkdirSync(path.join(repo, 'icons'), { recursive: true });
  fs.cpSync(path.join(REPO, 'android-build', 'res'), path.join(repo, 'android-build', 'res'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(repo, 'icons', 'a.png'), makePng(8, 8, () => [10, 100, 60, 255]));
  fs.writeFileSync(path.join(repo, 'manifest.json'), JSON.stringify({ theme_color: '#FFFFFF', icons: [{ src: 'icons/a.png', sizes: '192x192', type: 'image/png', purpose: 'any' }] }));
  const proj = makeProject('nomask');
  const r = run('android', proj, { repo });
  eq('no maskable icon: exit code', r.code, 0, r.out);
  check('no maskable icon: legacy icons used', !exists(path.join(proj, 'android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml')), r.out);
  const cfgDir = path.join(TMP, 'mini-cfg');
  const rc = run('config', cfgDir, { repo });
  eq('light theme colour: exit code', rc.code, 0, rc.out);
  eq('light theme colour -> LIGHT status bar style', JSON.parse(read(path.join(cfgDir, 'capacitor.config.json'))).plugins.SystemBars.style, 'LIGHT');
  fs.writeFileSync(path.join(repo, 'manifest.json'), '{ not json');
  const rb = run('config', path.join(TMP, 'mini-cfg2'), { repo });
  check('broken manifest.json only warns', rb.code === 0 && /not valid JSON/.test(rb.out), rb.out);
  eq('broken manifest.json falls back to the default theme', JSON.parse(read(path.join(TMP, 'mini-cfg2', 'capacitor.config.json'))).server.url, 'https://quranbangla.vercel.app');
}

// ---------------------------------------------------------------------------------------------- 10. Gradle text sanity
{
  const g = groovyBlock({ versionName: '1.1.0', versionCode: '123' });
  check('groovy: balanced braces', count(g, '{') === count(g, '}'));
  check('groovy: no template placeholders left', !/undefined|\$\{/.test(g));
  const k = ktsBlock({ versionName: '1.1.0', versionCode: '123' });
  check('kts: balanced braces', count(k, '{') === count(k, '}'));
}

// ---------------------------------------------------------------------------------------- 11. APK audit parsers
{
  const badging = `package: name='com.techverse.quranbangla' versionCode='123' versionName='1.1.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
sdkVersion:'24'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='android.permission.ACCESS_NETWORK_STATE'
uses-permission: name='android.permission.POST_NOTIFICATIONS'
uses-permission: name='android.permission.WAKE_LOCK'
uses-permission: name='com.google.android.c2dm.permission.RECEIVE'
uses-permission: name='com.techverse.quranbangla.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
uses-permission: name='android.permission.WRITE_EXTERNAL_STORAGE' maxSdkVersion='28'
uses-permission: name='android.permission.SOMETHING_NEW'
application-label:'Quran Bangla'
launchable-activity: name='com.techverse.quranbangla.MainActivity'  label='' icon=''
native-code: 'arm64-v8a' 'x86_64'
`;
  const b = parseBadging(badging);
  eq('badging package', b.package, 'com.techverse.quranbangla');
  eq('badging versionCode', b.versionCode, '123');
  eq('badging versionName', b.versionName, '1.1.0');
  eq('badging target sdk', b.targetSdk, '36');
  eq('badging min sdk', b.minSdk, '24');
  eq('badging compile sdk', b.compileSdk, '36');
  eq('badging permission count', b.permissions.length, 8);
  eq('badging launchable', b.launchable, 'com.techverse.quranbangla.MainActivity');
  eq('badging native code', b.nativeCode.join(','), 'arm64-v8a,x86_64');
  const c = classifyPermissions(b.permissions, 'com.techverse.quranbangla');
  eq('allowed permissions', c.allowed.length, 6);
  eq('forbidden permissions', c.forbidden.map((p) => p.name).join(','), 'android.permission.WRITE_EXTERNAL_STORAGE');
  eq('unexpected permissions', c.unexpected.map((p) => p.name).join(','), 'android.permission.SOMETHING_NEW');
  for (const p of ['android.permission.SCHEDULE_EXACT_ALARM', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.CAMERA', 'android.permission.READ_SMS', 'com.google.android.gms.permission.AD_ID', 'android.permission.ACCESS_BACKGROUND_LOCATION', 'android.permission.READ_CONTACTS'])
    eq('forbidden: ' + p, classifyPermissions([{ name: p, maxSdk: '' }], 'x.y').forbidden.length, 1);
  for (const p of ['android.permission.POST_NOTIFICATIONS', 'android.permission.ACCESS_FINE_LOCATION', 'android.permission.RECEIVE_BOOT_COMPLETED'])
    eq('allowed: ' + p, classifyPermissions([{ name: p, maxSdk: '' }], 'x.y').allowed.length, 1);
  const signer = parseApksigner(`Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Number of signers: 1
Signer #1 certificate DN: CN=Quran Bangla, O=TechVerse, C=BD
Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
Signer #1 certificate SHA-1 digest: 0123456789abcdef0123456789abcdef01234567
`);
  eq('apksigner verified', signer.verified, true);
  eq('apksigner v2 scheme', signer.schemes.v2, true);
  eq('apksigner DN', signer.signers[0].dn, 'CN=Quran Bangla, O=TechVerse, C=BD');
  eq('apksigner SHA-256 formatting', signer.signers[0].sha256, '01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF');
  check('debug certificate detected', isDebugCertificate('C=US, O=Android, CN=Android Debug') && !isDebugCertificate(signer.signers[0].dn));
  check('failed verification detected', parseApksigner('DOES NOT VERIFY\nERROR: JAR_SIG_NO_SIGNATURES').verified === false);
  eq('formatFingerprint', formatFingerprint('ab:cd:ef'), 'AB:CD:EF');
  const tree = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=123
    E: application (line=24)
      A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false
      E: activity (line=30)
        E: intent-filter (line=40)
          A: http://schemas.android.com/apk/res/android:autoVerify(0x010104ee)=true
          E: data (line=44)
            A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="https" (Raw: "https")
            A: http://schemas.android.com/apk/res/android:host(0x01010028)="quranbangla.vercel.app" (Raw: "quranbangla.vercel.app")
        E: intent-filter (line=50)
          E: data (line=54)
            A: http://schemas.android.com/apk/res/android:scheme(0x01010027)="quranbangla" (Raw: "quranbangla")
        E: meta-data (line=58)
          A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.app.shortcuts" (Raw: "android.app.shortcuts")
      E: meta-data (line=60)
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="com.google.firebase.messaging.default_notification_channel_id" (Raw: "x")
`;
  const mt = parseManifestTree(tree);
  check('manifest tree parsed', mt.parsed === true && mt.allowBackup === false && mt.autoVerify === true && mt.shortcuts === true && mt.fcmChannel === true);
  eq('manifest tree schemes', mt.schemes.join(','), 'https,quranbangla');
  eq('manifest tree hosts', mt.hosts.join(','), 'quranbangla.vercel.app');
  eq('manifest tree allowBackup true', parseManifestTree('  E: manifest (line=2)\n  A: x:allowBackup(0x01010280)=true').allowBackup, true);
  eq('manifest tree: unparsable output', parseManifestTree('garbage').parsed, false);
  const links = JSON.parse(assetlinksJson('com.techverse.quranbangla', [signer.signers[0].sha256]));
  eq('assetlinks package', links[0].target.package_name, 'com.techverse.quranbangla');
  eq('assetlinks relation', links[0].relation[0], 'delegate_permission/common.handle_all_urls');
  const md = renderMarkdown({ file: 'a.apk', kind: 'release', size: 5 * 1048576, sha256: 'abc', badging: b, permissions: c, manifest: mt, signer: signer.signers[0], debugKey: false, findings: [{ level: 'warn', text: 'w' }] });
  check('markdown report', md.includes('Certificate SHA-256') && md.includes('WARN: w') && md.includes('FORBIDDEN'));
}

// -------------------------------------------------------------------------------------------------------- report
if (process.env.QR_SELFTEST_KEEP === '1') console.log('test projects kept in ' + TMP);
else fs.rmSync(TMP, { recursive: true, force: true });
if (failures.length) {
  console.log(`\nself-test FAILED: ${failures.length} problem(s), ${passed} check(s) passed`);
  for (const f of failures) console.log(' - ' + f);
  process.exit(1);
}
console.log(`self-test OK: ${passed} checks passed`);
