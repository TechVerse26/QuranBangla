#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/audit-apk.mjs  -  looks inside a built APK and reports what a store reviewer would see.
//
//   node android-build/audit-apk.mjs --apk FILE --app-id ID --version-name V --version-code N [--kind debug|release]
//        [--strict] [--summary report.md] [--json report.json] [--assetlinks assetlinks.json]
//
// It uses the Android SDK build-tools that are preinstalled on GitHub's Ubuntu runners (aapt2, apksigner, zipalign) and
// checks: package / version, the exact list of permissions (allowed / forbidden / unexpected), the signing certificate
// (a release APK must not carry the debug key), the manifest features this project relies on (allowBackup=false,
// quranbangla:// links, https App Links, launcher shortcuts) and native-library alignment.
// With --strict a finding that would be a Play-policy problem makes the exit code 1; without it the report is advisory.
// The SHA-256 fingerprint of the signing certificate is printed together with a ready-to-use
// .well-known/assetlinks.json (needed for verified App Links).
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ALLOWED_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.VIBRATE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  // added by Firebase Cloud Messaging / AndroidX and not a privacy concern
  'android.permission.WAKE_LOCK',
  'com.google.android.c2dm.permission.RECEIVE'
];
export const FORBIDDEN_PERMISSION_PATTERNS = [
  /SCHEDULE_EXACT_ALARM|USE_EXACT_ALARM/,
  /READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_/,
  /READ_PHONE_STATE|READ_PHONE_NUMBERS|CALL_PHONE|READ_CALL_LOG|WRITE_CALL_LOG|PROCESS_OUTGOING_CALLS/,
  /_SMS|_MMS|BROADCAST_SMS/,
  /CONTACTS|GET_ACCOUNTS/,
  /\.CAMERA$|RECORD_AUDIO/,
  /FOREGROUND_SERVICE/,
  /QUERY_ALL_PACKAGES/,
  /permission\.AD_ID/,
  /SYSTEM_ALERT_WINDOW|REQUEST_INSTALL_PACKAGES|USE_FULL_SCREEN_INTENT/,
  /ACCESS_BACKGROUND_LOCATION|BODY_SENSORS|ACTIVITY_RECOGNITION/
];

// ------------------------------------------------------------------------------------------------------- parsers
export function parseBadging(text) {
  const out = { package: '', versionCode: '', versionName: '', compileSdk: '', minSdk: '', targetSdk: '', permissions: [], launchable: '', nativeCode: [], label: '' };
  for (const line of String(text).split(/\r?\n/)) {
    let m;
    if ((m = /^package:\s+name='([^']*)'\s+versionCode='([^']*)'\s+versionName='([^']*)'(.*)$/.exec(line))) {
      out.package = m[1]; out.versionCode = m[2]; out.versionName = m[3];
      const c = /compileSdkVersion='(\d+)'/.exec(m[4]);
      if (c) out.compileSdk = c[1];
    } else if ((m = /^sdkVersion:'?(\d+)'?/.exec(line))) out.minSdk = m[1];
    else if ((m = /^targetSdkVersion:'?(\d+)'?/.exec(line))) out.targetSdk = m[1];
    else if ((m = /^uses-permission(?:-sdk-23)?:\s+name='([^']+)'(?:\s+maxSdkVersion='(\d+)')?/.exec(line))) {
      if (!out.permissions.some((p) => p.name === m[1])) out.permissions.push({ name: m[1], maxSdk: m[2] || '' });
    } else if ((m = /^launchable-activity:\s+name='([^']*)'/.exec(line))) out.launchable = m[1];
    else if ((m = /^application-label:'([^']*)'/.exec(line))) out.label = m[1];
    else if ((m = /^native-code:\s*(.*)$/.exec(line))) out.nativeCode = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  return out;
}
export function classifyPermissions(permissions, appId) {
  const allowed = new Set(ALLOWED_PERMISSIONS);
  if (appId) allowed.add(appId + '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION');
  const res = { allowed: [], forbidden: [], unexpected: [] };
  for (const p of permissions) {
    if (FORBIDDEN_PERMISSION_PATTERNS.some((re) => re.test(p.name))) res.forbidden.push(p);
    else if (allowed.has(p.name)) res.allowed.push(p);
    else res.unexpected.push(p);
  }
  return res;
}
export function formatFingerprint(hex) {
  return String(hex).replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/(..)(?=.)/g, '$1:');
}
export function parseApksigner(text) {
  const t = String(text);
  const out = { verified: /^Verifies/m.test(t) && !/DOES NOT VERIFY/i.test(t), schemes: {}, signers: [] };
  for (const m of t.matchAll(/Verified using v(\d(?:\.\d)?) scheme[^:]*:\s*(true|false)/g)) out.schemes['v' + m[1]] = m[2] === 'true';
  // classic:  "Signer #1 certificate DN: ..."      newer build-tools:  "Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate DN: ..."
  const re = /Signer\s*(#\d+|\([^)\n]*\))\s*certificate (DN|SHA-256 digest|SHA-1 digest):\s*(.+)/g;
  const byName = new Map();
  let m;
  while ((m = re.exec(t))) {
    if (!byName.has(m[1])) byName.set(m[1], { dn: '', sha256: '', sha1: '' });
    const sg = byName.get(m[1]);
    if (m[2] === 'DN') sg.dn = m[3].trim();
    else if (m[2] === 'SHA-256 digest') sg.sha256 = formatFingerprint(m[3]);
    else sg.sha1 = formatFingerprint(m[3]);
  }
  out.signers = [...byName.values()];
  return out;
}
// The APK Signing Block (signature schemes v2 / v3 / v3.1) sits right before the ZIP central directory and carries the signer's
// X.509 certificate. Reading it directly gives the same fingerprint as `apksigner --print-certs`, whatever text format that tool
// prints, and needs only Node.js. (Checking that the signature is valid stays apksigner's job.)
const SIG_BLOCK_IDS = { 0x7109871a: 'v2', 0xf05368c0: 'v3', 0x1b93ad61: 'v3.1' };
export function readSigningBlockCertificates(buf) {
  const out = [];
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return out;
    const cd = buf.readUInt32LE(eocd + 16);                       // start of the central directory = end of the signing block
    if (cd < 32 || cd > buf.length) return out;
    if (buf.toString('latin1', cd - 16, cd) !== 'APK Sig Block 42') return out;
    const size = Number(buf.readBigUInt64LE(cd - 24));
    const start = cd - size - 8;
    if (start < 0 || Number(buf.readBigUInt64LE(start)) !== size) return out;
    let pos = start + 8;
    const end = cd - 24;
    while (pos + 12 <= end) {
      const len = Number(buf.readBigUInt64LE(pos));                // id (4 bytes) + value
      if (len < 4 || pos + 8 + len > end) break;
      const scheme = SIG_BLOCK_IDS[buf.readUInt32LE(pos + 8)];
      if (scheme) {
        // value = signers[ signer[ signedData[ digests, certificates[ cert, ... ], ... ], ... ], ... ]; every part is uint32-length-prefixed
        const v = buf.subarray(pos + 12, pos + 8 + len);
        let o = 8;                                                 // skip the signers length and the first signer's length
        const sdLen = v.readUInt32LE(o); o += 4;
        const sd = v.subarray(o, o + sdLen);
        let p = 4 + sd.readUInt32LE(0) + 4;                        // skip the digests and the certificate sequence's length
        const certLen = sd.readUInt32LE(p); p += 4;
        out.push({ scheme, der: Buffer.from(sd.subarray(p, p + certLen)) });
      }
      pos += 8 + len;
    }
  } catch { /* unreadable block - the caller reports the key as unknown */ }
  return out;
}
export function signerFromApk(file) {
  try {
    for (const c of readSigningBlockCertificates(fs.readFileSync(file))) {
      const x = new crypto.X509Certificate(c.der);
      return { dn: x.subject.split('\n').join(', '), sha256: formatFingerprint(x.fingerprint256), sha1: formatFingerprint(x.fingerprint), source: 'signing block ' + c.scheme };
    }
  } catch { /* not a readable certificate */ }
  return null;
}
// Diagnostic: what does GRADLE say it signs debug builds with? Printed next to the fingerprint found inside the APK, so that a
// mismatch can be traced (wrong key file, key not applied, or something else signing afterwards). Never fails the audit.
export function parseSigningReport(text) {
  const m = /^Variant: debug\r?\n([\s\S]*?)^-{5,}/m.exec(String(text));
  if (!m) return null;
  const pick = (key) => { const x = new RegExp('^' + key + ':[ \\t]*(.+)$', 'm').exec(m[1]); return x ? x[1].trim() : ''; };
  return { store: pick('Store'), alias: pick('Alias'), sha256: formatFingerprint(pick('SHA-256')), sha1: formatFingerprint(pick('SHA1')) };
}
export function gradleSigningReport(projectDir) {
  try {
    const dir = path.join(projectDir, 'android');
    const gradlew = path.join(dir, 'gradlew');
    if (!fs.existsSync(gradlew)) return null;
    const r = spawnSync(gradlew, [':app:signingReport'], { cwd: dir, encoding: 'utf8', timeout: 150000, maxBuffer: 16 * 1024 * 1024 });
    return parseSigningReport(String(r.stdout || '') + '\n' + String(r.stderr || ''));
  } catch { return null; }
}
export function isDebugCertificate(dn) { return /CN=Android Debug/i.test(dn || ''); }
// aapt2 dump xmltree output (attribute lines look like  A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false)
export function parseManifestTree(text) {
  const t = String(text);
  const attr = (name) => [...t.matchAll(new RegExp(name + '\\(0x[0-9a-fA-F]+\\)=(?:"([^"]*)"|([^\\s]+))', 'g'))].map((m) => (m[1] != null ? m[1] : m[2]));
  const bool = (v) => v === 'true' || v === '(type 0x12)0xffffffff' || v === '0xffffffff';
  const backup = attr('allowBackup');
  return {
    parsed: /E: manifest/.test(t),
    allowBackup: backup.length ? bool(backup[0]) : null,
    schemes: [...new Set(attr('scheme'))],
    hosts: [...new Set(attr('host'))],
    autoVerify: attr('autoVerify').some(bool),
    shortcuts: /android\.app\.shortcuts/.test(t),
    fcmChannel: /default_notification_channel_id/.test(t)
  };
}
export function assetlinksJson(appId, fingerprints) {
  return JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: appId, sha256_cert_fingerprints: fingerprints }
  }], null, 2) + '\n';
}

// ------------------------------------------------------------------------------------------------------- tools
function buildToolDirs() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, '/usr/local/lib/android/sdk', path.join(process.env.HOME || '', 'Android/Sdk')].filter(Boolean);
  const dirs = [];
  for (const r of roots) {
    const bt = path.join(r, 'build-tools');
    if (!fs.existsSync(bt)) continue;
    const versions = fs.readdirSync(bt).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pb[i] || 0) - (pa[i] || 0); if (d) return d; }
      return 0;
    });
    for (const v of versions) dirs.push(path.join(bt, v));
  }
  return dirs;
}
export function findTool(name) {
  for (const d of buildToolDirs()) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return '';
}
function runTool(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}

// ------------------------------------------------------------------------------------------------------- report
export function renderMarkdown(r) {
  const L = [];
  L.push(`### APK audit - ${r.file} (${r.kind})`, '');
  L.push('| | |', '|---|---|');
  L.push(`| Package | \`${r.badging.package}\` |`);
  L.push(`| Version | ${r.badging.versionName} (${r.badging.versionCode}) |`);
  L.push(`| SDK | min ${r.badging.minSdk || '?'} / target ${r.badging.targetSdk || '?'} / compile ${r.badging.compileSdk || '?'} |`);
  L.push(`| Size | ${(r.size / 1048576).toFixed(2)} MB |`);
  L.push(`| SHA-256 (file) | \`${r.sha256}\` |`);
  if (r.signer) {
    L.push(`| Signed by | ${r.signer.dn || '?'}${r.debugKey ? ' (**debug key**)' : ''} |`);
    L.push(`| Certificate SHA-256 | \`${r.signer.sha256}\` |`);
  }
  if (r.gradleDebugKey && r.gradleDebugKey.sha256) L.push(`| Gradle signs debug builds with | \`${r.gradleDebugKey.sha256}\` (keystore: \`${r.gradleDebugKey.store || '?'}\`) |`);
  L.push('', '**Permissions declared in the final manifest**', '');
  for (const p of r.permissions.allowed) L.push(`- ${p.name}${p.maxSdk ? ' (max SDK ' + p.maxSdk + ')' : ''}`);
  if (!r.permissions.allowed.length) L.push('- (none)');
  if (r.permissions.unexpected.length) { L.push('', '**Unexpected (review before publishing)**', ''); for (const p of r.permissions.unexpected) L.push(`- ${p.name}`); }
  if (r.permissions.forbidden.length) { L.push('', '**FORBIDDEN**', ''); for (const p of r.permissions.forbidden) L.push(`- ${p.name}`); }
  if (r.manifest && r.manifest.parsed) {
    L.push('', '**Manifest features**', '');
    L.push(`- allowBackup: ${r.manifest.allowBackup === null ? 'not set' : r.manifest.allowBackup}`);
    L.push(`- link schemes: ${r.manifest.schemes.join(', ') || 'none'}; hosts: ${r.manifest.hosts.join(', ') || 'none'}; autoVerify: ${r.manifest.autoVerify}`);
    L.push(`- launcher shortcuts: ${r.manifest.shortcuts}; FCM default channel: ${r.manifest.fcmChannel}`);
  }
  L.push('', `Native libraries: ${r.badging.nativeCode.length ? r.badging.nativeCode.join(', ') : 'none'}${r.alignment ? ' - ' + r.alignment : ''}`);
  if (r.findings.length) { L.push('', '**Findings**', ''); for (const f of r.findings) L.push(`- ${f.level.toUpperCase()}: ${f.text}`); }
  L.push('');
  return L.join('\n');
}

export function audit(opts) {
  const findings = [];
  const add = (level, text) => findings.push({ level, text });
  const apk = path.resolve(opts.apk);
  if (!fs.existsSync(apk)) throw new Error('APK not found: ' + apk);
  const result = { file: path.basename(apk), kind: opts.kind, size: fs.statSync(apk).size, findings };
  result.sha256 = spawnSync('sha256sum', [apk], { encoding: 'utf8' }).stdout.split(/\s+/)[0] || '';

  const aapt2 = findTool('aapt2');
  if (!aapt2) throw new Error('aapt2 not found - set ANDROID_HOME to an Android SDK with build-tools');
  const badging = runTool(aapt2, ['dump', 'badging', apk]);
  if (badging.code !== 0) throw new Error('aapt2 dump badging failed: ' + badging.out.slice(0, 400));
  result.badging = parseBadging(badging.out);
  if (opts.appId && result.badging.package !== opts.appId) add('error', `package is ${result.badging.package}, expected ${opts.appId}`);
  if (opts.versionCode && String(result.badging.versionCode) !== String(opts.versionCode)) add('error', `versionCode is ${result.badging.versionCode}, expected ${opts.versionCode}`);
  if (opts.versionName && result.badging.versionName !== opts.versionName) add('error', `versionName is ${result.badging.versionName}, expected ${opts.versionName}`);
  if (Number(result.badging.targetSdk) && Number(result.badging.targetSdk) < 35) add('warn', `targetSdkVersion ${result.badging.targetSdk} may be below Google Play's current requirement`);

  result.permissions = classifyPermissions(result.badging.permissions, opts.appId);
  for (const p of result.permissions.forbidden) add('error', `forbidden permission in the final manifest: ${p.name} (add it to PERMISSIONS_REMOVE in android-build/apply-native-patches.mjs)`);
  for (const p of result.permissions.unexpected) add('warn', `unexpected permission ${p.name} - confirm it is needed and update privacy.html + the Data Safety form`);

  const tree = runTool(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
  result.manifest = tree.code === 0 ? parseManifestTree(tree.out) : { parsed: false };
  if (result.manifest.parsed && opts.mode !== 'safe') {
    if (result.manifest.allowBackup !== false) add('error', 'android:allowBackup is not false');
    if (!result.manifest.schemes.includes('quranbangla')) add('error', 'the quranbangla:// link filter is missing');
    if (!result.manifest.shortcuts) add('error', 'launcher shortcuts are missing');
    if (!result.manifest.autoVerify) add('warn', 'App Link autoVerify is not set');
  } else if (!result.manifest.parsed) add('warn', 'could not read the manifest tree - manifest feature checks skipped');

  const signerTool = findTool('apksigner');
  let apksignerOut = '';
  result.signer = null;
  if (signerTool) {
    const v = runTool(signerTool, ['verify', '--verbose', '--print-certs', apk]);
    apksignerOut = v.out;
    const parsed = parseApksigner(v.out);
    if (v.code !== 0 || !parsed.verified) add('error', 'apksigner could not verify the APK signature: ' + v.out.slice(0, 300).replace(/\s+/g, ' '));
    result.signer = parsed.signers.find((x) => x.sha256) || null;
  } else add('warn', 'apksigner not found - signature not checked');
  if (!result.signer) {                                           // apksigner printed no certificate details: read the signing block ourselves
    result.signer = signerFromApk(apk);
    if (!result.signer && signerTool) add('warn', 'could not read the signing certificate; apksigner said: ' + apksignerOut.slice(0, 300).replace(/\s+/g, ' '));
  }
  result.debugKey = !!(result.signer && isDebugCertificate(result.signer.dn));
  if (opts.kind !== 'release' && process.env.QR_AUDIT_GRADLE !== '0') result.gradleDebugKey = gradleSigningReport(process.env.QR_PROJECT_DIR || '/tmp/app');
  if (opts.kind === 'release' && result.debugKey) add('error', 'the release APK is signed with the DEBUG key - the signing secrets were not applied');
  if (opts.kind === 'release' && !result.signer) add('error', 'the release APK is not signed');

  if (result.badging.nativeCode.length) {
    const zipalign = findTool('zipalign');
    if (zipalign) {
      const z = runTool(zipalign, ['-c', '-P', '16', '4', apk]);
      result.alignment = z.code === 0 ? '16 KB page alignment OK' : '16 KB page alignment FAILED';
      if (z.code !== 0) add('warn', 'native libraries are not 16 KB aligned (Google Play requirement for Android 15+ targets)');
    }
  }
  return result;
}

// ------------------------------------------------------------------------------------------------------- cli
function parseArgs(argv) {
  const o = { kind: 'debug', strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--apk') o.apk = next();
    else if (a === '--app-id') o.appId = next();
    else if (a === '--version-name') o.versionName = next();
    else if (a === '--version-code') o.versionCode = next();
    else if (a === '--kind') o.kind = next();
    else if (a === '--mode') o.mode = next();
    else if (a === '--summary') o.summary = next();
    else if (a === '--json') o.json = next();
    else if (a === '--assetlinks') o.assetlinks = next();
    else if (a === '--strict') o.strict = true;
    else throw new Error('unknown option ' + a);
  }
  if (!o.apk) throw new Error('usage: audit-apk.mjs --apk FILE --app-id ID [--version-name V --version-code N --kind debug|release --strict]');
  return o;
}
export function main(argv = process.argv.slice(2)) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  let result;
  try { result = audit(opts); } catch (e) { console.log('::error::' + String(e.message).replace(/\n/g, ' ')); return 1; }
  const md = renderMarkdown(result);
  console.log(md);
  const gha = process.env.GITHUB_ACTIONS === 'true';
  for (const f of result.findings) console.log(gha ? `::${f.level === 'error' ? 'error' : 'warning'}::${f.text}` : `${f.level.toUpperCase()}: ${f.text}`);
  if (opts.summary) fs.writeFileSync(opts.summary, md);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(result, null, 2) + '\n');
  if (opts.assetlinks && result.signer && result.signer.sha256) fs.writeFileSync(opts.assetlinks, assetlinksJson(opts.appId || result.badging.package, [result.signer.sha256]));
  const errors = result.findings.filter((f) => f.level === 'error').length;
  return opts.strict && errors ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
