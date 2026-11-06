#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/apply-native-patches.mjs
//
// The GitHub Actions workflow generates a brand-new Capacitor Android project on every run (`npx cap add android` in
// /tmp/app), so nothing can be edited by hand inside it. This script turns that generated project into the Quran Bangla
// app, in two phases (Capacitor needs its config BEFORE the project exists, the native files exist only AFTER it):
//
//   node android-build/apply-native-patches.mjs config   [--mode full|safe]   # before `npx cap add android`
//   node android-build/apply-native-patches.mjs android  [--mode full|safe]   # after  `npx cap add android`
//
// Modes
//   full  everything below.
//   safe  only what the previous build already did (server.url, edge-to-edge, launcher icon) plus version + signing.
//         The workflow falls back to this when a "full" DEBUG build fails, so that an installable APK still exists
//         while the problem is investigated. It never silently replaces a release build.
//
// What "full" does
//   config   capacitor.config.json (live URL, user-agent token, system bars, splash, notification icon),
//            www/index.html + www/error.html (offline page shown when the live site cannot be reached)
//   android  AndroidManifest.xml  : permissions (only what the app needs, exact-alarm / storage / phone / advertising-id
//                                   permissions are actively removed), https App Links + quranbangla:// links,
//                                   launcher shortcuts, Firebase Cloud Messaging defaults, allowBackup=false
//            app/build.gradle(.kts): versionName / versionCode and the release signing config (secrets come from
//                                   environment variables, nothing is ever written to disk in the repository)
//            res/                  : notification icon, shortcut icons, adaptive launcher icon, splash resources
//            google-services.json  : written from the GOOGLE_SERVICES_JSON secret (push notifications)
//
// Every text patch is string based, idempotent (marker "qr-android-build") and verified afterwards: the XML is checked
// for well-formedness and every @resource reference that was added must exist. A failed critical patch stops the build
// with a clear message instead of producing an app that silently lacks a feature. QR_PATCH_LENIENT=1 turns the
// non-critical failures into warnings.
//
// Environment (all set by .github/workflows/build-apk.yml)
//   APP_ID APP_NAME APP_VERSION APP_VERSION_CODE LIVE_URL            identity + version
//   GOOGLE_SERVICES_JSON                                              optional: Firebase config (JSON or base64)
//   QR_PROJECT_DIR (default /tmp/app)  QR_MODE  QR_PATCH_LENIENT      optional
// Only Node.js built-ins are used - no npm install is needed for this script.
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MARK = 'qr-android-build';

// ------------------------------------------------------------------------------------------------ configuration data
// Permissions the app really uses (privacy.html "Android permissions" lists exactly these - keep both in sync):
//   INTERNET / ACCESS_NETWORK_STATE   load the site, detect offline
//   POST_NOTIFICATIONS                prayer / announcement / reading-reminder notifications (asked only when switched on)
//   ACCESS_COARSE/FINE_LOCATION       optional: prayer times + Qibla. Android's WebView geolocation prompt asks for both;
//                                     the user may still choose "approximate" and can refuse
//   VIBRATE                           haptic feedback
//   RECEIVE_BOOT_COMPLETED            restore the daily reminder after a restart
export const PERMISSIONS_ADD = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION'
];
// Permissions a library might pull in that this app must never ship with.
export const PERMISSIONS_REMOVE = [
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_PHONE_STATE',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'com.google.android.gms.permission.AD_ID'
];
export const FEATURES_OPTIONAL = [
  'android.hardware.location',
  'android.hardware.location.gps',
  'android.hardware.location.network'
];
// Firebase Cloud Messaging defaults (used when a push message does not carry its own channel / icon).
// "announcements" is the default channel: prayer pushes send channelId "prayer" explicitly (scripts/send-prayer-notifications.js).
export const FCM_META = [
  ['com.google.firebase.messaging.default_notification_icon', 'android:resource', '@drawable/ic_stat_quran'],
  ['com.google.firebase.messaging.default_notification_color', 'android:resource', '@color/qr_notification_color'],
  ['com.google.firebase.messaging.default_notification_channel_id', 'android:value', 'announcements']
];
const DEFAULT_THEME = '#092723';
const NOTIFICATION_COLOR = '#0F5C4D';

// ------------------------------------------------------------------------------------------------------- small utils
class PatchError extends Error {}
const read = (f) => fs.readFileSync(f, 'utf8');
const exists = (f) => fs.existsSync(f);
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ghaEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.replace(/\r\n/g, '\n'));
}
function walk(dir) {
  const out = [];
  if (!exists(dir)) return out;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

// ------------------------------------------------------------------------------------------------ XML well-formedness
// Node has no XML parser. This small checker catches what string patching can break: unbalanced / mismatched tags,
// duplicate attributes, unterminated comments or quotes, bare "&", more than one root element.
const NAME = '[A-Za-z_][\\w:.\\-]*';
const reOpen = new RegExp('<(' + NAME + ')', 'y');
const reClose = new RegExp('</(' + NAME + ')\\s*>', 'y');
const reAttr = new RegExp('\\s+(' + NAME + ')\\s*=\\s*(?:"([^"<]*)"|\'([^\'<]*)\')', 'y');
const reSpace = /\s*/y;
const BAD_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
export function checkXml(source) {
  const s = stripBom(source);
  const n = s.length;
  let i = 0;
  let roots = 0;
  const stack = [];
  const problem = (msg) => `${msg} (offset ${i}: ${JSON.stringify(s.slice(Math.max(0, i - 40), i + 40))})`;
  while (i < n) {
    const lt = s.indexOf('<', i);
    const text = lt < 0 ? s.slice(i) : s.slice(i, lt);
    if (stack.length === 0) {
      if (text.trim() !== '') return problem('text outside the root element');
    } else if (BAD_AMP.test(text)) return problem('unescaped & in text');
    if (lt < 0) break;
    i = lt;
    if (s.startsWith('<!--', i)) {
      const e = s.indexOf('-->', i + 4);
      if (e < 0) return problem('unterminated comment');
      if (s.slice(i + 4, e).includes('--')) return problem('"--" inside a comment');
      i = e + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const e = s.indexOf(']]>', i + 9);
      if (e < 0) return problem('unterminated CDATA section');
      i = e + 3;
      continue;
    }
    if (s.startsWith('<?', i)) {
      const e = s.indexOf('?>', i + 2);
      if (e < 0) return problem('unterminated processing instruction');
      i = e + 2;
      continue;
    }
    if (s.startsWith('<!', i)) {
      const e = s.indexOf('>', i + 2);
      if (e < 0) return problem('unterminated declaration');
      i = e + 1;
      continue;
    }
    if (s.startsWith('</', i)) {
      reClose.lastIndex = i;
      const m = reClose.exec(s);
      if (!m) return problem('malformed closing tag');
      const top = stack.pop();
      if (top !== m[1]) return problem(`</${m[1]}> does not match <${top}>`);
      i = reClose.lastIndex;
      continue;
    }
    reOpen.lastIndex = i;
    const m = reOpen.exec(s);
    if (!m) return problem('malformed tag');
    if (stack.length === 0) {
      roots++;
      if (roots > 1) return problem('more than one root element');
    }
    i = reOpen.lastIndex;
    const seen = new Set();
    for (;;) {
      reAttr.lastIndex = i;
      const a = reAttr.exec(s);
      if (a) {
        if (seen.has(a[1])) return problem(`duplicate attribute ${a[1]} on <${m[1]}>`);
        seen.add(a[1]);
        if (BAD_AMP.test(a[2] != null ? a[2] : a[3])) return problem(`unescaped & in attribute ${a[1]}`);
        i = reAttr.lastIndex;
        continue;
      }
      reSpace.lastIndex = i;
      reSpace.exec(s);
      i = reSpace.lastIndex;
      if (s.startsWith('/>', i)) { i += 2; break; }
      if (s[i] === '>') { i += 1; stack.push(m[1]); break; }
      return problem(`malformed attribute list in <${m[1]}>`);
    }
  }
  if (stack.length) return `unclosed element(s): ${stack.join(', ')}`;
  if (roots === 0) return 'no root element';
  return null;
}

// ------------------------------------------------------------------------------------------------------------ PNG
// Minimal decoder (8-bit RGB / RGBA, not interlaced) - only used to read the edge colour of the maskable icon.
export function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG file');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6)) throw new Error('unsupported PNG variant (need 8-bit RGB/RGBA, not interlaced)');
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('truncated PNG data');
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const inRow = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = inRow[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (ft !== 0) throw new Error('bad PNG filter type ' + ft);
      row[x] = v & 255;
    }
  }
  return { width: w, height: h, bpp, data: out };
}
// average colour of the four corners (opaque pixels only) as #RRGGBB
export function cornerColor(png, block = 6) {
  let r = 0, g = 0, b = 0, count = 0;
  const corners = [[0, 0], [png.width - block, 0], [0, png.height - block], [png.width - block, png.height - block]];
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + block; y++) {
      for (let x = cx; x < cx + block; x++) {
        const o = (y * png.width + x) * png.bpp;
        if (png.bpp === 4 && png.data[o + 3] < 250) continue;
        r += png.data[o]; g += png.data[o + 1]; b += png.data[o + 2]; count++;
      }
    }
  }
  if (!count) throw new Error('icon corners are transparent');
  const hex = (v) => Math.round(v / count).toString(16).padStart(2, '0');
  return ('#' + hex(r) + hex(g) + hex(b)).toUpperCase();
}

// -------------------------------------------------------------------------------------------------- AndroidManifest
function setAttr(tag, name, value) {
  const re = new RegExp('(\\s' + escRe(name) + '\\s*=\\s*)("[^"]*"|\'[^\']*\')');
  if (re.test(tag)) return tag.replace(re, (all, pre) => pre + '"' + value + '"');
  return tag.replace(/^(<[\w:.\-]+)/, (all, head) => head + '\n        ' + name + '="' + value + '"');
}
function mergeToolsReplace(tag, attrs) {
  const re = /(\stools:replace\s*=\s*)"([^"]*)"/;
  const m = re.exec(tag);
  if (!m) return setAttr(tag, 'tools:replace', attrs.join(','));
  const have = m[2].split(',').map((x) => x.trim()).filter(Boolean);
  for (const a of attrs) if (!have.includes(a)) have.push(a);
  return tag.replace(re, (all, pre) => pre + '"' + have.join(',') + '"');
}
function declaredPermissionNames(text) {
  const out = new Set();
  const re = /<uses-permission(?:-sdk-\d+)?\b[^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    const n = /android:name\s*=\s*"([^"]+)"/.exec(m[0]);
    if (n) out.add(n[1]);
  }
  return out;
}
function declaredFeatureNames(text) {
  const out = new Set();
  const re = /<uses-feature\b[^>]*>/g;
  let m;
  while ((m = re.exec(text))) {
    const n = /android:name\s*=\s*"([^"]+)"/.exec(m[0]);
    if (n) out.add(n[1]);
  }
  return out;
}
function insertBefore(text, closingTag, block) {
  const at = text.lastIndexOf(closingTag);
  if (at < 0) throw new Error(`${closingTag} not found`);
  // keep the indentation of the closing tag on its own line
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const before = text.slice(0, lineStart);
  const rest = text.slice(lineStart);
  const lead = text.slice(lineStart, at);
  return before + block.replace(/\s+$/, '') + '\n' + (lead.trim() === '' ? lead : '') + rest.slice(lead.trim() === '' ? lead.length : 0);
}

// Pure function: AndroidManifest text in -> patched text out (exported for the self-test).
export function patchManifestText(source, cfg) {
  if (source.includes(MARK)) return { text: source, changed: false, added: [], removed: [], notes: ['already patched'] };
  const host = cfg.host;
  if (!/^[A-Za-z0-9.-]+$/.test(host || '')) throw new Error('invalid host for the App Link filter: ' + host);
  let m = source.replace(/\r\n/g, '\n');
  const notes = [];

  // 1. xmlns:tools on <manifest>
  const rootTag = /<manifest\b[^>]*>/.exec(m);
  if (!rootTag) throw new Error('no <manifest> element found');
  if (!/\sxmlns:tools\s*=/.test(rootTag[0])) {
    const patched = rootTag[0].replace(/(\sxmlns:android\s*=\s*"[^"]*")/, (all) => all + '\n    xmlns:tools="http://schemas.android.com/tools"');
    if (patched === rootTag[0]) throw new Error('could not add xmlns:tools (xmlns:android not found)');
    m = m.replace(rootTag[0], () => patched);
  }

  // 2. permissions + optional hardware features (before </manifest>)
  const have = declaredPermissionNames(m);
  const added = PERMISSIONS_ADD.filter((p) => !have.has(p));
  const removed = PERMISSIONS_REMOVE.filter((p) => !have.has(p));
  const alreadyDeclaredButForbidden = PERMISSIONS_REMOVE.filter((p) => have.has(p));
  if (alreadyDeclaredButForbidden.length) {
    // a forbidden permission written straight into the generated manifest: turn that line into a removal marker
    for (const p of alreadyDeclaredButForbidden) {
      const re = new RegExp('<uses-permission\\b[^>]*android:name\\s*=\\s*"' + escRe(p) + '"[^>]*/>');
      if (!re.test(m)) throw new Error('permission ' + p + ' is declared in an unsupported form');
      m = m.replace(re, () => '<uses-permission android:name="' + p + '" tools:node="remove" />');
      notes.push('forbidden permission already in manifest, marked for removal: ' + p);
    }
  }
  const haveFeatures = declaredFeatureNames(m);
  const features = FEATURES_OPTIONAL.filter((f) => !haveFeatures.has(f));
  const permLines = [];
  if (added.length) {
    permLines.push('    <!-- ' + MARK + ': permissions the app needs (listed in privacy.html under "Android permissions") -->');
    for (const p of added) permLines.push('    <uses-permission android:name="' + p + '" />');
  }
  if (removed.length) {
    permLines.push('    <!-- ' + MARK + ': permissions that libraries must not add to this app -->');
    for (const p of removed) permLines.push('    <uses-permission android:name="' + p + '" tools:node="remove" />');
  }
  if (features.length) {
    permLines.push('    <!-- ' + MARK + ': location hardware stays optional so the app can be installed on every device -->');
    for (const f of features) permLines.push('    <uses-feature android:name="' + f + '" android:required="false" />');
  }
  if (!permLines.length) permLines.push('    <!-- ' + MARK + ': permissions already present -->');
  m = insertBefore(m, '</manifest>', '\n' + permLines.join('\n'));

  // 3. <application> attributes + Firebase Cloud Messaging defaults
  const appTag = /<application\b[^>]*>/.exec(m);
  if (!appTag) throw new Error('no <application> element found');
  if (/\/>$/.test(appTag[0])) throw new Error('<application> is self-closing - unexpected manifest layout');
  let t = appTag[0];
  t = setAttr(t, 'android:allowBackup', 'false');
  t = mergeToolsReplace(t, ['android:allowBackup']);
  m = m.replace(appTag[0], () => t);
  const metaLines = [];
  for (const [name, attr, value] of FCM_META) {
    if (m.includes('android:name="' + name + '"')) { notes.push('meta-data already present: ' + name); continue; }
    metaLines.push('        <meta-data android:name="' + name + '" ' + attr + '="' + value + '" tools:replace="' + attr + '" />');
  }
  if (metaLines.length) {
    m = insertBefore(m, '</application>', '\n        <!-- ' + MARK + ': defaults for push messages (small icon, accent colour, channel) -->\n' + metaLines.join('\n'));
  }

  // 4. launcher activity: https App Links, quranbangla:// links, shortcuts
  const actRe = /<activity\b[\s\S]*?<\/activity>/g;
  let act = null, hit;
  while ((hit = actRe.exec(m))) {
    if (/android\.intent\.action\.MAIN/.test(hit[0]) && /android\.intent\.category\.LAUNCHER/.test(hit[0])) { act = hit[0]; break; }
  }
  if (!act) throw new Error('launcher activity (MAIN / LAUNCHER) not found in the manifest');
  let patchedAct = act;
  const openTag = /<activity\b[^>]*>/.exec(patchedAct)[0];
  let newOpen = openTag;
  if (!/android:exported\s*=/.test(newOpen)) newOpen = setAttr(newOpen, 'android:exported', 'true');
  if (!/android:launchMode\s*=/.test(newOpen)) newOpen = setAttr(newOpen, 'android:launchMode', 'singleTask');
  patchedAct = patchedAct.replace(openTag, () => newOpen);
  const filters = [
    '            <!-- ' + MARK + ': links to the website open the app (verified through /.well-known/assetlinks.json), quranbangla:// links, launcher shortcuts -->',
    '            <intent-filter android:autoVerify="true">',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    '                <data android:scheme="https" android:host="' + host + '" android:path="/" />',
    '                <data android:scheme="https" android:host="' + host + '" android:path="/index.html" />',
    '            </intent-filter>',
    '            <intent-filter>',
    '                <action android:name="android.intent.action.VIEW" />',
    '                <category android:name="android.intent.category.DEFAULT" />',
    '                <category android:name="android.intent.category.BROWSABLE" />',
    '                <data android:scheme="quranbangla" />',
    '            </intent-filter>',
    '            <meta-data android:name="android.app.shortcuts" android:resource="@xml/shortcuts" />'
  ].join('\n');
  const closeAt = patchedAct.lastIndexOf('</activity>');
  const lineStart = patchedAct.lastIndexOf('\n', closeAt) + 1;
  patchedAct = patchedAct.slice(0, lineStart) + filters + '\n' + patchedAct.slice(lineStart);
  m = m.replace(act, () => patchedAct);

  const bad = checkXml(m);
  if (bad) throw new Error('patched AndroidManifest.xml is not well-formed: ' + bad);
  return { text: m, changed: true, added, removed, notes };
}

// ------------------------------------------------------------------------------------------------------------ Gradle
export function groovyBlock({ versionName, versionCode }) {
  return [
    '',
    '// ===== ' + MARK + ': added by android-build/apply-native-patches.mjs (this project is generated again on every CI run) =====',
    'android {',
    '    defaultConfig {',
    '        versionCode = ' + versionCode,
    '        versionName = "' + versionName + '"',
    '    }',
    '}',
    '',
    '// Release signing: the keystore and its passwords exist only as GitHub secrets and reach Gradle through environment',
    '// variables (see .github/workflows/build-apk.yml). Without them no release signing config is created.',
    "def qrKeystorePath = System.getenv('QR_KEYSTORE_PATH')",
    'if (qrKeystorePath) {',
    '    android {',
    '        signingConfigs {',
    '            qrRelease {',
    '                storeFile = file(qrKeystorePath)',
    "                storePassword = System.getenv('QR_KEYSTORE_PASSWORD')",
    "                keyAlias = System.getenv('QR_KEY_ALIAS')",
    "                keyPassword = System.getenv('QR_KEY_PASSWORD')",
    '            }',
    '        }',
    '        buildTypes {',
    '            release {',
    "                signingConfig = signingConfigs.getByName('qrRelease')",
    '            }',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
}
export function ktsBlock({ versionName, versionCode }) {
  return [
    '',
    '// ===== ' + MARK + ': added by android-build/apply-native-patches.mjs (this project is generated again on every CI run) =====',
    'android {',
    '    defaultConfig {',
    '        versionCode = ' + versionCode,
    '        versionName = "' + versionName + '"',
    '    }',
    '}',
    '',
    '// Release signing: the keystore and its passwords exist only as GitHub secrets (environment variables).',
    'val qrKeystorePath: String? = System.getenv("QR_KEYSTORE_PATH")',
    'if (!qrKeystorePath.isNullOrEmpty()) {',
    '    android {',
    '        signingConfigs {',
    '            create("qrRelease") {',
    '                storeFile = file(qrKeystorePath)',
    '                storePassword = System.getenv("QR_KEYSTORE_PASSWORD")',
    '                keyAlias = System.getenv("QR_KEY_ALIAS")',
    '                keyPassword = System.getenv("QR_KEY_PASSWORD")',
    '            }',
    '        }',
    '        buildTypes {',
    '            getByName("release") {',
    '                signingConfig = signingConfigs.getByName("qrRelease")',
    '            }',
    '        }',
    '    }',
    '}',
    ''
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------- www/ templates
const CRESCENT_PATH = 'M12,3c-4.97,0 -9,4.03 -9,9s4.03,9 9,9 9,-4.03 9,-9c0,-0.46 -0.04,-0.92 -0.1,-1.36 -0.98,1.37 -2.58,2.26 -4.4,2.26 -2.98,0 -5.4,-2.42 -5.4,-5.4 0,-1.81 0.89,-3.42 2.26,-4.4 -0.44,-0.06 -0.9,-0.1 -1.36,-0.1z';
const jsString = (s) => JSON.stringify(String(s)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
export function placeholderIndexHtml({ liveUrl, appName }) {
  return `<!doctype html>
<html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(appName)}</title></head>
<body style="margin:0;background:#092723;color:#fff;font:16px system-ui,sans-serif">
<p style="padding:24px"><a style="color:#fff" href="${escHtml(liveUrl)}">${escHtml(appName)}</a></p>
<script>location.replace(${jsString(liveUrl)});</script>
</body></html>
`;
}
// Shown by Capacitor (server.errorPath) when the live site cannot be reached - e.g. first start without internet.
// Once the site has been opened a single time its service worker keeps it available offline, so this page is rare.
export function errorPageHtml({ liveUrl, appName }) {
  return `<!doctype html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${escHtml(appName)}</title>
<style>
:root{--bg:#F6F4EE;--fg:#16231F;--muted:#4B5C56;--brand:#0F5C4D;--brand-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0B1513;--fg:#E7EFEB;--muted:#A9BAB3;--brand:#4FB79F;--brand-fg:#06201A}}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,"Noto Sans Bengali","Hind Siliguri",Roboto,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;text-align:center}
main{max-width:360px}
svg{width:64px;height:64px;color:var(--brand)}
h1{font-size:1.25rem;margin:16px 0 8px}
p{margin:0 0 6px;color:var(--muted);line-height:1.55}
button{margin-top:20px;font:inherit;font-weight:600;background:var(--brand);color:var(--brand-fg);border:0;border-radius:999px;padding:12px 28px;min-height:48px}
button[disabled]{opacity:.6}
#status{min-height:1.5em;margin-top:12px}
</style></head>
<body>
<main>
<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${CRESCENT_PATH}"/></svg>
<h1 lang="bn">ইন্টারনেট সংযোগ নেই</h1>
<p lang="bn">${escHtml(appName)} খুলতে ইন্টারনেট সংযোগ লাগবে। সংযোগ ঠিক হলে আবার চেষ্টা করুন।</p>
<p lang="en">No internet connection. Connect and try again.</p>
<button id="retry" type="button">আবার চেষ্টা করুন · Try again</button>
<p id="status" role="status" aria-live="polite"></p>
</main>
<script>
(function(){
  var URL_ = ${jsString(liveUrl)};
  var btn = document.getElementById('retry'), status = document.getElementById('status'), busy = false;
  // the native splash screen is released by the website; this local page has to release it itself
  try{ var s = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.SplashScreen; if(s && s.hide) s.hide({ fadeOutDuration: 150 }); }catch(e){}
  function say(t){ status.textContent = t; }
  function check(){
    if(busy) return;
    busy = true; btn.disabled = true; say('যাচাই করা হচ্ছে… / Checking…');
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctl) ctl.abort(); }, 8000);
    fetch(URL_ + (URL_.indexOf('?') < 0 ? '?' : '&') + 'qr_retry=' + Date.now(), { mode: 'no-cors', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function(){ clearTimeout(timer); window.location.replace(URL_); })
      .catch(function(){ clearTimeout(timer); busy = false; btn.disabled = false; say('এখনও সংযোগ পাওয়া যাচ্ছে না / Still offline'); });
  }
  btn.addEventListener('click', check);
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && navigator.onLine !== false) check(); });
})();
</script>
</body></html>
`;
}

// ----------------------------------------------------------------------------------------------- web manifest + icons
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
function findWebRoot(repo) {
  for (const d of ['dist', 'build', 'public', 'www']) if (exists(path.join(repo, d, 'index.html'))) return path.join(repo, d);
  return repo;
}
function readWebManifest(repo, warn) {
  const root = findWebRoot(repo);
  for (const f of ['manifest.json', 'manifest.webmanifest', 'site.webmanifest']) {
    const file = path.join(root, f);
    if (!exists(file)) continue;
    try { return { root, file, data: JSON.parse(stripBom(read(file))) }; }
    catch (e) { warn(`${f} is not valid JSON (${e.message}) - defaults used`); }
  }
  return { root, file: '', data: {} };
}
export function pickIcons(web) {
  const list = Array.isArray(web.data.icons) ? web.data.icons : [];
  const sizeOf = (i) => parseInt(String(i.sizes || '').split(/\s+/)[0], 10) || 0;
  const purposes = (i) => String(i.purpose || 'any').split(/\s+/);
  const resolve = (i) => {
    const rel = String(i.src).split('?')[0];
    return rel.startsWith('/') ? path.join(web.root, rel) : path.join(path.dirname(web.file || path.join(web.root, 'x')), rel);
  };
  const png = list.filter((i) => i && typeof i.src === 'string' && /\.png(\?|$)/i.test(i.src)).map((i) => ({ file: resolve(i), size: sizeOf(i), purposes: purposes(i) })).filter((i) => exists(i.file));
  const anyIcons = png.filter((i) => i.purposes.includes('any')).sort((a, b) => a.size - b.size);
  const maskable = png.filter((i) => i.purposes.includes('maskable')).sort((a, b) => b.size - a.size);
  return {
    // legacy launcher icon (Android 7 and the "round" fallback): smallest 'any' icon that is at least 192 px
    legacy: (anyIcons.find((i) => i.size >= 192) || anyIcons[anyIcons.length - 1] || {}).file || '',
    // largest 'any' icon (pre-Android-12 splash screen)
    large: (anyIcons[anyIcons.length - 1] || {}).file || '',
    // adaptive icon foreground
    maskable: (maskable[0] || {}).file || ''
  };
}

// ----------------------------------------------------------------------------------------------------------- context
function parseArgs(argv, env) {
  const out = { phase: '', mode: env.QR_MODE || 'full', project: env.QR_PROJECT_DIR || '/tmp/app', repo: env.GITHUB_WORKSPACE || path.resolve(HERE, '..'), report: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a.startsWith('--')) throw new PatchError('unknown option ' + a);
    else rest.push(a);
  }
  out.phase = rest[0] || '';
  return out;
}
function readSettings(env) {
  const s = {
    appId: (env.APP_ID || '').trim(),
    appName: (env.APP_NAME || '').trim(),
    versionName: (env.APP_VERSION || '').trim(),
    versionCode: (env.APP_VERSION_CODE || '').trim(),
    liveUrl: (env.LIVE_URL || '').trim()
  };
  const errors = [];
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(s.appId)) errors.push('APP_ID is not a valid Android application id: "' + s.appId + '"');
  if (!s.appName) errors.push('APP_NAME is empty');
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(s.versionName)) errors.push('APP_VERSION must look like 1.2.3 (letters, digits, . _ + - only): "' + s.versionName + '"');
  if (!/^[1-9][0-9]{0,9}$/.test(s.versionCode) || Number(s.versionCode) > 2100000000) errors.push('APP_VERSION_CODE must be a whole number between 1 and 2100000000: "' + s.versionCode + '"');
  let host = '';
  try {
    const u = new URL(s.liveUrl);
    if (u.protocol !== 'https:') errors.push('LIVE_URL must start with https://');
    host = u.hostname;
  } catch (e) { errors.push('LIVE_URL is missing or not a valid URL: "' + s.liveUrl + '"'); }
  s.host = host;
  if (errors.length) throw new PatchError(errors.join('\n'));
  return s;
}
function makeContext(argv, env) {
  const args = parseArgs(argv, env);
  if (!['config', 'android'].includes(args.phase)) throw new PatchError('usage: apply-native-patches.mjs <config|android> [--mode full|safe] [--project DIR] [--repo DIR]');
  if (!['full', 'safe'].includes(args.mode)) throw new PatchError('--mode must be "full" or "safe"');
  const S = readSettings(env);
  const gha = env.GITHUB_ACTIONS === 'true';
  const report = { phase: args.phase, mode: args.mode, appId: S.appId, versionName: S.versionName, versionCode: Number(S.versionCode), steps: [], warnings: [] };
  const ctx = {
    S, env, report, gha,
    mode: args.mode,
    project: path.resolve(args.project),
    repo: path.resolve(args.repo),
    buildDir: path.join(path.resolve(args.repo), 'android-build'),
    reportFile: args.report,
    lenient: env.QR_PATCH_LENIENT === '1',
    log: (...a) => console.log(...a),
    warn: (msg) => { report.warnings.push(msg); console.log(gha ? '::warning::' + ghaEscape(msg) : 'WARNING: ' + msg); }
  };
  ctx.res = path.join(ctx.project, 'android', 'app', 'src', 'main', 'res');
  ctx.web = readWebManifest(ctx.repo, ctx.warn);
  const theme = ctx.web.data.theme_color;
  ctx.theme = /^#[0-9a-f]{6}$/i.test(theme || '') ? theme.toUpperCase() : DEFAULT_THEME;
  ctx.icons = pickIcons(ctx.web);
  return ctx;
}
function runStep(ctx, name, fn, { critical = false } = {}) {
  try {
    const detail = fn();
    ctx.report.steps.push({ name, status: 'ok', detail: detail == null ? '' : String(detail) });
    ctx.log('OK   ' + name + (detail ? ' - ' + detail : ''));
    return true;
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (critical || !ctx.lenient) {
      ctx.report.steps.push({ name, status: 'failed', detail: msg });
      throw new PatchError(name + ': ' + msg);
    }
    ctx.warn(name + ' skipped (QR_PATCH_LENIENT=1): ' + msg);
    ctx.report.steps.push({ name, status: 'skipped', detail: msg });
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------- phase 1
function phaseConfig(ctx) {
  const { S } = ctx;
  const www = path.join(ctx.project, 'www');
  fs.mkdirSync(www, { recursive: true });

  runStep(ctx, 'capacitor.config.json', () => {
    const cfg = {
      appId: S.appId,
      appName: S.appName,
      webDir: 'www',
      server: { url: S.liveUrl },
      // the token lets js/platform.js recognise the app even if the native bridge is injected a moment late
      // (the "fcm" flag is added later, in the android phase, only if Firebase really got configured - markFcmFlag)
      android: { appendUserAgent: userAgentToken(S.versionName, S.versionCode) },
      plugins: { SystemBars: { insetsHandling: 'disable' } }
    };
    const lum = luminance(ctx.theme);
    if (ctx.web.data.theme_color && /^#[0-9a-f]{6}$/i.test(ctx.web.data.theme_color)) {
      cfg.plugins.EdgeToEdge = { backgroundColor: ctx.theme };
      cfg.plugins.SystemBars.style = lum < 0.5 ? 'DARK' : 'LIGHT';
    }
    if (ctx.mode === 'full') {
      cfg.server.cleartext = false;
      cfg.server.errorPath = 'error.html';
      cfg.android.allowMixedContent = false;
      // The page releases the splash screen as soon as the app UI is on screen (js/platform.js); the duration is only a
      // safety net so an unreachable or outdated page can never leave the splash screen up.
      cfg.plugins.SplashScreen = {
        launchAutoHide: true,
        launchShowDuration: 8000,
        launchFadeOutDuration: 180,
        backgroundColor: ctx.theme,
        androidSplashResourceName: 'qr_splash',
        androidScaleType: 'CENTER',
        showSpinner: false
      };
      cfg.plugins.LocalNotifications = { smallIcon: 'ic_stat_quran', iconColor: NOTIFICATION_COLOR };
    }
    write(path.join(ctx.project, 'capacitor.config.json'), JSON.stringify(cfg, null, 2) + '\n');
    return `server.url ${S.liveUrl}, theme ${ctx.theme}`;
  }, { critical: true });

  runStep(ctx, 'www/index.html', () => {
    write(path.join(www, 'index.html'), placeholderIndexHtml({ liveUrl: S.liveUrl, appName: S.appName }));
    return 'placeholder (the app loads the live site)';
  }, { critical: true });

  if (ctx.mode === 'full') {
    runStep(ctx, 'www/error.html', () => {
      write(path.join(www, 'error.html'), errorPageHtml({ liveUrl: S.liveUrl, appName: S.appName }));
      return 'offline page with retry';
    });
  }
}

// ---------------------------------------------------------------------------------------------------------- phase 2
function patchGradle(ctx) {
  const dir = path.join(ctx.project, 'android', 'app');
  const groovy = path.join(dir, 'build.gradle');
  const kts = path.join(dir, 'build.gradle.kts');
  const file = exists(groovy) ? groovy : exists(kts) ? kts : '';
  if (!file) throw new Error('android/app/build.gradle(.kts) was not generated');
  let s = read(file);
  if (s.includes(MARK)) return 'already patched';
  if (!/\bandroid\s*\{/.test(s)) throw new Error('no android { } block in ' + path.basename(file));
  const block = (file.endsWith('.kts') ? ktsBlock : groovyBlock)({ versionName: ctx.S.versionName, versionCode: ctx.S.versionCode });
  s = s.replace(/\s*$/, '\n') + block;
  write(file, s);
  return `${path.basename(file)}: versionName ${ctx.S.versionName}, versionCode ${ctx.S.versionCode}, release signing from environment`;
}

function readSdk(ctx) {
  const f = path.join(ctx.project, 'android', 'variables.gradle');
  if (!exists(f)) return null;
  const t = read(f);
  const pick = (k) => { const m = new RegExp(k + '\\s*=\\s*(\\d+)').exec(t); return m ? Number(m[1]) : null; };
  return { min: pick('minSdkVersion'), compile: pick('compileSdkVersion'), target: pick('targetSdkVersion') };
}

function patchManifest(ctx) {
  const file = path.join(ctx.project, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!exists(file)) throw new Error('AndroidManifest.xml was not generated');
  const r = patchManifestText(read(file), { host: ctx.S.host });
  if (r.changed) write(file, r.text);
  ctx.report.permissionsAdded = r.added;
  ctx.report.permissionsRemoved = r.removed;
  return r.changed ? `${r.added.length} permission(s) added, ${r.removed.length} blocked, App Links for ${ctx.S.host}, shortcuts, FCM defaults` : 'already patched';
}

function copyResources(ctx) {
  const src = path.join(ctx.buildDir, 'res');
  if (!exists(src)) throw new Error('android-build/res is missing from the repository');
  let n = 0;
  for (const f of walk(src)) {
    const rel = path.relative(src, f);
    const dst = path.join(ctx.res, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (/\.(xml|txt)$/i.test(f)) {
      const text = read(f).split('__APP_ID__').join(ctx.S.appId);
      if (/\.xml$/i.test(f)) {
        const bad = checkXml(text);
        if (bad) throw new Error(`android-build/res/${rel.split(path.sep).join('/')} is not well-formed: ${bad}`);
      }
      write(dst, text);
    } else fs.copyFileSync(f, dst);
    n++;
  }
  return n + ' resource file(s) copied';
}

function writeThemeResources(ctx) {
  let iconBg = ctx.theme;
  let how = 'from manifest.json theme_color';
  if (ctx.icons.maskable) {
    try { iconBg = cornerColor(decodePng(fs.readFileSync(ctx.icons.maskable))); how = 'sampled from the maskable icon'; }
    catch (e) { ctx.warn('could not read the maskable icon colour (' + e.message + '); theme_color used'); }
  }
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
    '    <color name="qr_splash_background">' + ctx.theme + '</color>\n' +
    '    <color name="qr_icon_background">' + iconBg + '</color>\n</resources>\n';
  write(path.join(ctx.res, 'values', 'qr_theme.xml'), xml);
  return `splash ${ctx.theme}, icon background ${iconBg} (${how})`;
}

function patchIcons(ctx) {
  if (!exists(ctx.res)) throw new Error('res directory was not generated');
  const { legacy, large, maskable } = ctx.icons;
  if (!legacy) return 'no PNG icon in manifest.json - the Capacitor default icon stays';
  let n = 0;
  for (const dir of fs.readdirSync(ctx.res)) {
    if (!/^mipmap-/.test(dir) || dir.includes('anydpi')) continue;
    for (const f of fs.readdirSync(path.join(ctx.res, dir))) {
      if (/^ic_launcher(_round|_foreground)?\.png$/.test(f)) { fs.copyFileSync(legacy, path.join(ctx.res, dir, f)); n++; }
    }
  }
  const adaptive = ctx.mode === 'full' && maskable;
  if (!adaptive) {
    // same as the previous workflow: plain (non-adaptive) launcher icon from manifest.json
    let removed = 0;
    for (const dir of fs.readdirSync(ctx.res)) {
      if (!/^mipmap-/.test(dir)) continue;
      for (const f of fs.readdirSync(path.join(ctx.res, dir))) {
        if (/^ic_launcher.*\.xml$/.test(f)) { fs.unlinkSync(path.join(ctx.res, dir, f)); removed++; }
      }
    }
    return `legacy launcher icon, ${n} PNG(s) replaced, ${removed} adaptive definition(s) removed`;
  }
  // adaptive icon (Android 8+): the maskable PNG already has a full-bleed background and a safe zone. It is placed at
  // 84 % of the 108 dp canvas so that the artwork stays inside the 66 dp circle that every launcher mask guarantees.
  fs.mkdirSync(path.join(ctx.res, 'drawable-nodpi'), { recursive: true });
  fs.copyFileSync(maskable, path.join(ctx.res, 'drawable-nodpi', 'qr_icon_foreground.png'));
  fs.copyFileSync(large || legacy, path.join(ctx.res, 'drawable-nodpi', 'qr_splash_icon.png'));
  write(path.join(ctx.res, 'drawable', 'qr_icon_foreground_inset.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<inset xmlns:android="http://schemas.android.com/apk/res/android"\n    android:drawable="@drawable/qr_icon_foreground"\n    android:inset="8%" />\n');
  const adaptiveXml = '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/qr_icon_background" />\n' +
    '    <foreground android:drawable="@drawable/qr_icon_foreground_inset" />\n</adaptive-icon>\n';
  write(path.join(ctx.res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), adaptiveXml);
  write(path.join(ctx.res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'), adaptiveXml);
  // splash screen for Android 7-11 (Android 12+ uses the launcher icon on windowSplashScreenBackground)
  write(path.join(ctx.res, 'drawable', 'qr_splash.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <item android:width="168dp" android:height="168dp" android:gravity="center">\n' +
    '        <bitmap android:src="@drawable/qr_splash_icon" android:gravity="fill" />\n    </item>\n</layer-list>\n');
  return `adaptive icon from ${path.basename(maskable)}, legacy PNGs from ${path.basename(legacy)} (${n} files)`;
}

function patchStyles(ctx) {
  const file = path.join(ctx.res, 'values', 'styles.xml');
  if (!exists(file)) return 'values/styles.xml not found - splash background left as generated';
  let s = read(file);
  if (s.includes('windowSplashScreenBackground')) return 'splash background already set';
  const re = /<style\s+name="AppTheme\.NoActionBarLaunch"[^>]*parent="[^"]*SplashScreen[^"]*"[^>]*>/;
  if (!re.test(s)) return 'launch theme is not a SplashScreen theme - splash background left as generated';
  s = s.replace(re, (all) => all + '\n        <item name="windowSplashScreenBackground">@color/qr_splash_background</item>');
  const bad = checkXml(s);
  if (bad) throw new Error('patched styles.xml is not well-formed: ' + bad);
  write(file, s);
  return 'launch theme: windowSplashScreenBackground = theme colour';
}

function patchGoogleServices(ctx) {
  const raw = (ctx.env.GOOGLE_SERVICES_JSON || '').trim();
  ctx.report.fcm = false;
  if (!raw) {
    ctx.warn('GOOGLE_SERVICES_JSON secret is not set: this build has NO push notifications (FCM). Everything else works. See docs/ANDROID_BUILD_BN.md.');
    return 'not configured - push notifications disabled in this build';
  }
  let text = raw;
  if (!raw.startsWith('{')) {
    try { text = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { /* handled below */ }
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('GOOGLE_SERVICES_JSON is neither valid JSON nor base64-encoded JSON'); }
  const clients = Array.isArray(json.client) ? json.client : [];
  const packages = clients.map((c) => c && c.client_info && c.client_info.android_client_info && c.client_info.android_client_info.package_name).filter(Boolean);
  if (!packages.includes(ctx.S.appId)) {
    throw new Error('google-services.json has no Android app with package name "' + ctx.S.appId + '" (it contains: ' + (packages.join(', ') || 'none') + '). Register this package in the Firebase console and download the file again.');
  }
  const project = json.project_info && json.project_info.project_id;
  const target = path.join(ctx.project, 'android', 'app', 'google-services.json');
  write(target, JSON.stringify(json, null, 2) + '\n');
  // the website and the app must use the SAME Firebase project (shared Firestore, one push sender)
  const cfgFile = path.join(ctx.repo, 'js', 'firebase-config.js');
  if (project && exists(cfgFile)) {
    const m = /projectId\s*:\s*["']([^"']+)["']/.exec(read(cfgFile));
    if (m && m[1] !== project) ctx.warn('google-services.json belongs to Firebase project "' + project + '" but the website uses "' + m[1] + '" - push messages sent by the website project will not reach this app.');
  }
  // The Google services Gradle plugin must be applied, otherwise the file is ignored, Firebase is never initialised and
  // PushNotifications.register() would crash the app. So this is an error, not a warning.
  const appGradle = ['build.gradle', 'build.gradle.kts'].map((f) => path.join(ctx.project, 'android', 'app', f)).find(exists);
  const rootGradle = ['build.gradle', 'build.gradle.kts'].map((f) => path.join(ctx.project, 'android', f)).find(exists);
  const appText = appGradle ? read(appGradle) : '';
  const rootText = rootGradle ? read(rootGradle) : '';
  if (!/google-services/.test(appText)) {
    if (!/com\.google\.gms:google-services/.test(rootText)) throw new Error('the generated project does not contain the Google services Gradle plugin, so google-services.json would be ignored and push registration would fail at run time');
    if (appGradle.endsWith('.kts')) throw new Error('the Google services plugin is not applied in build.gradle.kts - add it manually');
    fs.appendFileSync(appGradle, '\n// ' + MARK + ': apply the Google services plugin (google-services.json is present)\napply plugin: \'com.google.gms.google-services\'\n');
  }
  ctx.report.fcm = true;
  return `google-services.json written (Firebase project ${project || '?'}, package ${ctx.S.appId})`;
}

// The web layer must know whether Firebase is configured in this APK: calling PushNotifications.register() without a
// Firebase app crashes the process on Android. The page already reads the user agent (js/platform.js, app/js/native.js),
// so the capability travels there: "QuranBanglaApp/<version> (<code>; fcm)". Only added when google-services.json was
// really installed and the Gradle plugin applied (patchGoogleServices), and written to BOTH copies of the Capacitor
// config (the project's and the one `cap add` copied into the Android assets, which is the one read at run time).
export const FCM_FLAG = 'fcm';
export function userAgentToken(versionName, versionCode, flags = []) {
  return 'QuranBanglaApp/' + versionName + ' (' + versionCode + (flags.length ? '; ' + flags.join(' ') : '') + ')';
}
function markFcmFlag(ctx) {
  if (!ctx.report.fcm) return 'no Firebase configuration: the app UI will not offer push notifications';
  const token = userAgentToken(ctx.S.versionName, ctx.S.versionCode, [FCM_FLAG]);
  const files = [
    path.join(ctx.project, 'capacitor.config.json'),
    path.join(ctx.project, 'android', 'app', 'src', 'main', 'assets', 'capacitor.config.json')
  ];
  for (const file of files) {
    if (!exists(file)) throw new Error(path.relative(ctx.project, file) + ' not found - cannot tell the app that push notifications are configured');
    let cfg;
    try { cfg = JSON.parse(read(file)); } catch (e) { throw new Error(path.relative(ctx.project, file) + ' is not valid JSON'); }
    cfg.android = Object.assign({}, cfg.android, { appendUserAgent: token });
    write(file, JSON.stringify(cfg, null, 2) + '\n');
  }
  ctx.report.fcmFlag = true;
  return 'user agent token "' + token + '" written to ' + files.length + ' config file(s)';
}

// every @resource reference in the files this script created must exist, otherwise aapt2 fails much later with a long log
function collectDefinedResources(resDir) {
  const defined = new Set();
  for (const dir of fs.existsSync(resDir) ? fs.readdirSync(resDir) : []) {
    const full = path.join(resDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    const type = dir.split('-')[0];
    for (const f of fs.readdirSync(full)) {
      if (type === 'values') {
        const text = read(path.join(full, f));
        const re = /<(string|color|style|dimen|bool|integer|array|plurals|string-array|integer-array)\s[^>]*?name\s*=\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(text))) defined.add((m[1].endsWith('-array') ? 'array' : m[1]) + '/' + m[2]);
      } else defined.add(type + '/' + f.replace(/\.[^.]+$/, ''));
    }
  }
  return defined;
}
export function findUnresolvedRefs(files, resDir) {
  const defined = collectDefinedResources(resDir);
  const missing = [];
  for (const f of files) {
    if (!exists(f)) continue;
    const text = read(f).replace(/<!--[\s\S]*?-->/g, '');
    const re = /@(drawable|color|string|mipmap|xml|style|layout|dimen|bool|integer)\/([A-Za-z0-9_.]+)/g;
    let m;
    while ((m = re.exec(text))) {
      const key = m[1] + '/' + m[2];
      if (!defined.has(key)) missing.push(path.basename(f) + ': @' + key);
    }
  }
  return [...new Set(missing)];
}
function verifyRefs(ctx) {
  const manifest = path.join(ctx.project, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const mine = [manifest];
  for (const f of walk(ctx.res)) {
    const base = path.basename(f);
    if (/^(qr_|ic_stat_quran|ic_shortcut_|shortcuts\.xml$)/.test(base) || (/ic_launcher(_round)?\.xml$/.test(base) && f.includes('anydpi'))) mine.push(f);
  }
  const styles = path.join(ctx.res, 'values', 'styles.xml');
  if (exists(styles)) mine.push(styles);
  const missing = findUnresolvedRefs(mine.filter((f) => f.endsWith('.xml')), ctx.res);
  // references that only the manifest / styles of the template define (colorPrimary ...) are not ours to judge
  const real = missing.filter((x) => /@(drawable|color|xml|mipmap)\/(qr_|ic_stat_quran|ic_shortcut_|shortcuts|ic_launcher)/.test(x));
  if (real.length) throw new Error('unresolved resource reference(s): ' + real.join(', '));
  return `${mine.length} file(s) checked`;
}

function phaseAndroid(ctx) {
  const manifest = path.join(ctx.project, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!exists(manifest)) throw new PatchError('android/app/src/main/AndroidManifest.xml not found - did `npx cap add android` run in ' + ctx.project + '?');
  const sdk = readSdk(ctx);
  ctx.report.sdk = sdk;
  if (sdk) {
    ctx.log(`SDK levels from variables.gradle: min ${sdk.min}, compile ${sdk.compile}, target ${sdk.target}`);
    if (sdk.target && sdk.target < 35) ctx.warn(`targetSdkVersion is ${sdk.target}. Google Play requires a recent target API level for new apps and updates - check the current requirement in the Play Console before uploading.`);
  }
  runStep(ctx, 'Gradle: version + release signing', () => patchGradle(ctx), { critical: true });
  if (ctx.mode === 'full') {
    runStep(ctx, 'AndroidManifest.xml', () => patchManifest(ctx), { critical: true });
    runStep(ctx, 'Android resources', () => copyResources(ctx));
    runStep(ctx, 'Theme colours', () => writeThemeResources(ctx));
  }
  runStep(ctx, 'Launcher icon', () => patchIcons(ctx));
  if (ctx.mode === 'full') {
    runStep(ctx, 'Splash theme', () => patchStyles(ctx));
    runStep(ctx, 'google-services.json (push notifications)', () => patchGoogleServices(ctx));
    runStep(ctx, 'Push capability flag', () => markFcmFlag(ctx));
    runStep(ctx, 'Resource references', () => verifyRefs(ctx), { critical: true });
  }
}

// ------------------------------------------------------------------------------------------------------------ main
export function summaryMarkdown(report) {
  const lines = [`### Android native patches (${report.phase}, mode **${report.mode}**)`, '', '| Step | Result |', '|---|---|'];
  for (const s of report.steps) lines.push(`| ${s.name} | ${s.status === 'ok' ? 'OK' : s.status.toUpperCase()}${s.detail ? ' - ' + String(s.detail).replace(/\|/g, '/').replace(/\n/g, ' ') : ''} |`);
  if (report.phase === 'android' && report.mode === 'full') {
    lines.push('', 'Push notifications (Firebase Cloud Messaging): **' + (report.fcmFlag ? 'enabled in this build' : 'NOT enabled - add the GOOGLE_SERVICES_JSON secret (docs/ANDROID_BUILD_BN.md)') + '**');
  }
  if (report.warnings.length) { lines.push('', '**Warnings**', ''); for (const w of report.warnings) lines.push('- ' + w); }
  lines.push('');
  return lines.join('\n');
}
export function main(argv = process.argv.slice(2), env = process.env) {
  let ctx;
  try {
    ctx = makeContext(argv, env);
    console.log(`== apply-native-patches: phase ${ctx.report.phase}, mode ${ctx.mode}, ${ctx.S.appId} ${ctx.S.versionName} (${ctx.S.versionCode}) ==`);
    if (ctx.report.phase === 'config') phaseConfig(ctx); else phaseAndroid(ctx);
    return finish(ctx, 0);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log((env.GITHUB_ACTIONS === 'true' ? '::error::' + ghaEscape(msg) : 'ERROR: ' + msg));
    if (ctx) return finish(ctx, 1, msg);
    return 1;
  }
}
function finish(ctx, code, error) {
  if (error) ctx.report.error = error;
  try {
    const file = ctx.reportFile || path.join(ctx.project, 'qr-patch-report.' + ctx.report.phase + '.json');
    write(file, JSON.stringify(ctx.report, null, 2) + '\n');
    if (ctx.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(ctx.env.GITHUB_STEP_SUMMARY, summaryMarkdown(ctx.report) + '\n');
  } catch (e) { /* the report is a courtesy */ }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
