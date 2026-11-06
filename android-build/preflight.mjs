#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/preflight.mjs  -  cheap repository checks that run before the slow Android build starts.
//
//   node android-build/preflight.mjs [--release]
//
// Fails (exit 1) on things that would ship a broken app: a JavaScript syntax error, a missing app UI file, a missing
// icon, a service-worker precache entry that does not exist (a 404 there makes the whole offline cache fail).
// Warns about things that must be filled in before a Google Play release (contact e-mail on the policy pages).
// Only Node.js built-ins are used.
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GITHUB_WORKSPACE || path.resolve(HERE, '..');
const RELEASE = process.argv.includes('--release') || process.env.QR_BUILD_RELEASE === 'true';
const gha = process.env.GITHUB_ACTIONS === 'true';
const errors = [];
const warnings = [];

const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
const abs = (p) => path.join(REPO, p.replace(/^\.\//, '').split('?')[0].split('#')[0]);
const exists = (p) => fs.existsSync(abs(p));
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const fail = (m) => { errors.push(m); console.log(gha ? '::error::' + esc(m) : 'ERROR: ' + m); };
const warn = (m) => { warnings.push(m); console.log(gha ? '::warning::' + esc(m) : 'WARNING: ' + m); };

function listFiles(dir, ext) {
  const out = [];
  const full = abs(dir);
  if (!fs.existsSync(full)) return out;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// 1. every JavaScript file compiles (nothing is executed)
let checked = 0;
for (const f of [...listFiles('js', '.js'), ...listFiles('app/js', '.js'), 'sw.js', 'app-config.js']) {
  if (!exists(f)) continue;
  try { new vm.Script(read(f), { filename: f }); checked++; }
  catch (e) { fail(`${f}: JavaScript syntax error - ${e.message}`); }
}
console.log(`JavaScript syntax: ${checked} file(s) checked`);

// 2. the files js/platform.js loads in the app exist
if (!exists('js/platform.js')) fail('js/platform.js is missing');
else {
  const text = read('js/platform.js');
  const block = (name) => { const m = new RegExp('var ' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]').exec(text); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null; };
  const styles = block('APP_STYLES'), scripts = block('APP_SCRIPTS');
  if (!styles || !scripts) fail('could not read APP_STYLES / APP_SCRIPTS from js/platform.js');
  else {
    for (const f of [...styles, ...scripts]) if (!exists(f)) fail(`app UI file listed in js/platform.js does not exist: ${f}`);
    console.log(`app UI files: ${styles.length} stylesheet(s), ${scripts.length} script(s)`);
  }
}
if (exists('index.html') && !/<script[^>]+src="js\/platform\.js"/.test(read('index.html'))) fail('index.html does not load js/platform.js (the app UI would never start)');

// 3. the service worker precache lists point at real files
for (const file of ['js/data.js', 'sw.js']) {
  if (!exists(file)) continue;
  const text = read(file);
  for (const name of ['APP_SHELL_CORE', 'APP_SHELL_DEFERRED']) {
    const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;').exec(text);
    if (!m) continue;
    const entries = [...m[1].matchAll(/'(\.\/[^']*|\/[^']*)'/g)].map((x) => x[1]).filter((x) => x !== './' && x !== '/');
    const missing = entries.filter((x) => !exists(x));
    if (missing.length) fail(`${file} ${name} lists file(s) that do not exist: ${missing.join(', ')}`);
    else console.log(`${file} ${name}: ${entries.length} file(s) exist`);
  }
}

// 4. manifest + icons
if (!exists('manifest.json')) fail('manifest.json is missing');
else {
  try {
    const m = JSON.parse(read('manifest.json'));
    if (!/^#[0-9a-f]{6}$/i.test(m.theme_color || '')) warn('manifest.json theme_color is not a #RRGGBB colour - the default will be used for the system bars');
    const icons = (m.icons || []).filter((i) => /\.png/i.test(i.src));
    if (!icons.length) fail('manifest.json has no PNG icons (needed for the launcher icon)');
    for (const i of icons) if (!exists(i.src)) fail(`manifest.json icon does not exist: ${i.src}`);
    if (!icons.some((i) => /maskable/.test(i.purpose || ''))) warn('manifest.json has no "maskable" icon - the launcher icon will not be adaptive');
  } catch (e) { fail('manifest.json is not valid JSON: ' + e.message); }
}

// 5. native resources + scripts of this folder
for (const f of ['android-build/apply-native-patches.mjs', 'android-build/create-project.sh', 'android-build/res/xml/shortcuts.xml', 'android-build/res/drawable/ic_stat_quran.xml', 'android-build/res/values/qr_colors.xml']) {
  if (!exists(f)) fail(`${f} is missing`);
}

// 6. things that must be filled in before Google Play
for (const f of ['privacy.html', 'terms.html', 'account-deletion.html']) if (!exists(f)) fail(`${f} is missing (Google Play requires a privacy policy and an account-deletion page)`);
if (exists('app-config.js')) {
  const cfg = read('app-config.js');
  const email = /supportEmail\s*:\s*'([^']*)'/.exec(cfg);
  const dev = /developerName\s*:\s*'([^']*)'/.exec(cfg);
  const note = 'app-config.js: ';
  if (!email || !email[1].trim()) (RELEASE ? warn : (m) => console.log('NOTE: ' + m))(note + 'supportEmail is empty - the privacy policy shows no contact address yet. Google Play requires a contact point; set it before publishing.');
  if (!dev || !dev[1].trim()) (RELEASE ? warn : (m) => console.log('NOTE: ' + m))(note + 'developerName is empty - the privacy policy does not name the developer yet.');
} else fail('app-config.js is missing');

console.log(`\npreflight: ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
