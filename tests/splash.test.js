'use strict';
// Static checks of the Android launch splash (Lottie): no browser needed, runs with `npm test`.
// The browser run (real app + simulated Android shell) is tests/ui/splash.ui.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const ANIMATION = 'assets/animations/quran-bangla-splash.json';
// sha256 of the animation exactly as the owner supplied it. The animation must stay untouched: if it is replaced ON PURPOSE,
// update this value in the same commit.
const ORIGINAL_SHA256 = 'abb25d9b8796f37179e2c49abe0c09bed7223d5b4a89125c82300788798e4f41';

// the JavaScript of a file without // and /* */ comments (good enough for the string checks below)
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

test('the animation is the original file, byte for byte', () => {
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, ANIMATION))), ORIGINAL_SHA256);
});

test('the animation keeps its original composition', () => {
  const a = JSON.parse(read(ANIMATION));
  assert.equal(a.w, 1080);
  assert.equal(a.h, 1920);
  assert.equal(a.fr, 30);
  assert.equal(a.ip, 0);
  assert.equal(a.op, 96);
  assert.equal(a.layers.length, 4);
  const solid = a.layers.find((l) => l.ty === 1);
  assert.equal(String(solid.sc).toUpperCase(), '#FFFFFF', 'pure white background');
});

test('js/platform.js starts the splash only inside the app, after the website early-return', () => {
  const text = code('js/platform.js');
  const earlyReturn = text.indexOf('if(!P.isApp) return;');
  assert.ok(earlyReturn > 0, 'the website early-return exists');
  const before = text.slice(0, earlyReturn);
  assert.doesNotMatch(before, /lottie|SPLASH_FILES|qa-splash|app\/js\/splash|assets\/animations/i, 'nothing about the Lottie splash before the early-return');
  const files = text.indexOf('var SPLASH_FILES');
  assert.ok(files > earlyReturn, 'SPLASH_FILES is defined after the early-return');
  assert.ok(text.indexOf('s.src = SPLASH_FILES.script') > earlyReturn, 'splash.js is injected after the early-return');
});

test('js/platform.js hands the right files to the splash', () => {
  const m = /var SPLASH_FILES\s*=\s*\{([\s\S]*?)\}/.exec(read('js/platform.js'));
  const files = Object.fromEntries([...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
  assert.deepEqual(files, {
    script: 'app/js/splash.js',
    runtime: 'assets/vendor/lottie/lottie_svg.min.js',
    data: ANIMATION,
    fallback: 'icons/icon-512.png'
  });
  for (const k of ['script', 'data', 'fallback']) assert.ok(exists(files[k]), files[k] + ' exists');
});

test('the existing native splash / boot safety nets are unchanged', () => {
  const text = code('js/platform.js');
  assert.match(text, /var BOOT_TIMEOUT_MS = 12000;/);
  assert.match(text, /setTimeout\(hideSplash, 9000\)/);
  assert.match(text, /SplashScreen\.hide\(\{ fadeOutDuration: 180 \}\)/);
  assert.match(text, /P\.markReady = function/);
  assert.match(text, /P\.fail = function/);
});

test('markReady() leaves the native splash to the Lottie splash while it holds it; fail() always releases it', () => {
  const text = code('js/platform.js');
  assert.match(text, /if\(!\(P\.splash && P\.splash\.holdsNative\)\) hideSplash\(\);/);
  const fail = /P\.fail = function[\s\S]*?\n  \};/.exec(text)[0];
  assert.match(fail, /P\.splash\.holdsNative = false;[\s\S]*hideSplash\(\);/);
});

test('platform.js has its own last-resort timer, so a broken splash.js can never keep the overlay on screen', () => {
  const text = code('js/platform.js');
  assert.match(text, /var SPLASH_START_TIMEOUT_MS = 5000;/);
  assert.match(text, /var SPLASH_LAST_RESORT_MS = 16000;/);
  assert.match(text, /s\.onerror = function\(\)\{ giveUp\(/);
});

test('the website never references the launch splash', () => {
  assert.doesNotMatch(read('index.html'), /lottie|quran-bangla-splash|app\/js\/splash|assets\/animations/i);
  for (const f of ['js/data.js', 'sw.js']) {
    const text = read(f);
    for (const name of ['APP_SHELL_CORE', 'APP_SHELL_DEFERRED']) {
      const m = new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;').exec(text);
      if (m) assert.doesNotMatch(m[1], /lottie|splash|assets\/animations/i, `${f} ${name}`);
    }
  }
});

test('the app asks the service worker to keep the splash files for offline starts', () => {
  const boot = code('app/js/boot.js');
  assert.match(boot, /P\.splash && P\.splash\.files/);
  assert.match(boot, /\[sp\.script, sp\.runtime, sp\.data\]/);
});

test('the service-worker cache generation was bumped (platform.js / boot.js / native.js are served cache-first)', () => {
  const m = /const SW_VERSION = '(v\d+\.\d+\.\d+\.\d+)'/.exec(read('js/data.js'));
  assert.ok(m, 'SW_VERSION found');
  assert.notEqual(m[1], 'v1.03.03.01808', 'the pre-splash cache generation');
});

test('native.js keeps its hands off the system bars while the splash holds them', () => {
  const nat = code('app/js/native.js');
  assert.match(nat, /var hold = P\.splash;\s*if\(hold && hold\.barsHeld\)\{ hold\.pendingScheme = scheme; return; \}/);
});

test('splash.js hands the splash files to the service worker right after they loaded (offline starts)', () => {
  const text = code('app/js/splash.js');
  assert.match(text, /type: 'CACHE_ASSETS', urls: \[FILES\.script \|\| 'app\/js\/splash\.js', RUNTIME_URL, DATA_URL\]/);
  assert.match(text, /cancel\('assets'\);\s*keepOffline\(\);\s*init\(r\[1\]\);/);
});

test('the vendor workflow starts by itself when the script is pushed, and cannot loop', () => {
  const y = read('.github/workflows/vendor-lottie.yml');
  assert.match(y, /workflow_dispatch:/);
  assert.match(y, /push:\s*\n\s*paths:\s*\n\s*- 'android-build\/vendor-lottie\.mjs'/);
  assert.match(y, /contents: write/);
  assert.match(y, /git add assets\/vendor\/lottie\b/);
  const paths = /paths:\s*\n((?:\s*- .*\n)+)/.exec(y)[1];
  assert.doesNotMatch(paths, /assets\//, 'the files it commits must not be a trigger path');
});

test('splash.js loads nothing from the internet (no CDN)', () => {
  assert.doesNotMatch(code('app/js/splash.js'), /https?:\/\//);
});

function runSplashScript(platform) {
  const calls = [];
  const note = (name) => () => { calls.push(name); return null; };
  const win = {
    QR_PLATFORM: platform,
    addEventListener: note('window.addEventListener'),
    removeEventListener: note('window.removeEventListener'),
    dispatchEvent: note('window.dispatchEvent'),
    performance: { now: () => 1 },
    console
  };
  const doc = { documentElement: {}, head: null, createElement: note('createElement'), getElementById: note('getElementById') };
  win.window = win; win.document = doc;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app/js/splash.js'), 'utf8'), win, { filename: 'app/js/splash.js' });
  return calls;
}

test('splash.js does nothing when it is not the Android app (website guard)', () => {
  assert.deepEqual(runSplashScript({ isApp: false, splash: { files: {} } }), [], 'isApp is false');
  assert.deepEqual(runSplashScript({ isApp: false }), []);
  assert.deepEqual(runSplashScript(undefined), []);
});

test('splash.js does nothing twice, and nothing after platform.js gave up on it', () => {
  assert.deepEqual(runSplashScript({ isApp: true, splash: { started: true, files: {} } }), []);
  assert.deepEqual(runSplashScript({ isApp: true, splash: { gaveUp: true, files: {} } }), []);
});

test('vendor-lottie.mjs pins the lottie-web version the animation was exported for', () => {
  const pinned = /const VERSION = '([^']+)'/.exec(read('android-build/vendor-lottie.mjs'))[1];
  assert.equal(pinned, JSON.parse(read(ANIMATION)).v);
});

test('a vendored lottie-web runtime (when present) matches its VERSION.json and has its license', (t) => {
  if (!exists('assets/vendor/lottie/lottie_svg.min.js')) return t.skip('runtime not vendored yet - run the "Vendor Lottie runtime" workflow');
  const meta = JSON.parse(read('assets/vendor/lottie/VERSION.json'));
  assert.equal(meta.name, 'lottie-web');
  assert.equal(meta.version, JSON.parse(read(ANIMATION)).v);
  assert.equal(sha256(fs.readFileSync(path.join(ROOT, 'assets/vendor/lottie/lottie_svg.min.js'))), meta.sha256);
  assert.ok(['LICENSE.md', 'LICENSE', 'LICENSE.txt'].some((n) => exists('assets/vendor/lottie/' + n)), 'license kept next to the code');
});

test('vendor-lottie.mjs copies player + license + version info out of an npm tarball (offline, fake package)', (t) => {
  let hasNpm = true;
  try { execFileSync('npm', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }); } catch (e) { hasNpm = false; }
  if (!hasNpm) return t.skip('npm is not available');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-lottie-test-'));
  try {
    const pkg = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(pkg, 'build', 'player'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'lottie-web', version: JSON.parse(read(ANIMATION)).v, license: 'MIT' }));
    fs.writeFileSync(path.join(pkg, 'LICENSE.md'), 'fake license for the test\n');
    const player = 'var lottie={loadAnimation:function(){}};' + '/*pad*/'.repeat(12000);
    fs.writeFileSync(path.join(pkg, 'build', 'player', 'lottie_svg.min.js'), player);
    execFileSync('npm', ['pack', '--silent'], { cwd: pkg, stdio: 'ignore', shell: process.platform === 'win32' });
    const tgz = fs.readdirSync(pkg).find((f) => f.endsWith('.tgz'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const run = (extra) => execFileSync(process.execPath, [path.join(ROOT, 'android-build', 'vendor-lottie.mjs')], {
      env: Object.assign({}, process.env, { VENDOR_LOTTIE_REPO: repo, LOTTIE_TARBALL: path.join(pkg, tgz) }, extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    run();
    const out = path.join(repo, 'assets', 'vendor', 'lottie');
    assert.equal(fs.readFileSync(path.join(out, 'lottie_svg.min.js'), 'utf8'), player, 'the player is copied unchanged');
    assert.equal(fs.readFileSync(path.join(out, 'LICENSE.md'), 'utf8'), 'fake license for the test\n');
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'VERSION.json'), 'utf8'));
    assert.equal(meta.sha256, sha256(Buffer.from(player)));
    assert.match(run(), /already up to date/);
    assert.throws(() => run({ LOTTIE_SHA256: 'deadbeef' }), /sha256 mismatch|Command failed/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
