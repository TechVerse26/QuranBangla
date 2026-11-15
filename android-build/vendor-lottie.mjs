#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------------------------------
// android-build/vendor-lottie.mjs  -  puts the official, version-pinned lottie-web runtime into the repository.
//
//   node android-build/vendor-lottie.mjs
//
// The Android launch splash (app/js/splash.js) plays assets/animations/quran-bangla-splash.json with the official lottie-web
// library (SVG renderer). The app loads it from its own site - never from a CDN - so the file has to live in the repository:
//
//     assets/vendor/lottie/lottie_svg.min.js   the SVG player of lottie-web, byte for byte as published on npm
//     assets/vendor/lottie/LICENSE.md          the license text that ships with the package (MIT) - kept next to the code
//     assets/vendor/lottie/VERSION.json        name, version, sha256, npm integrity - android-build/preflight.mjs checks it
//
// What it does: `npm pack lottie-web@<pinned version>` (npm verifies the package against the registry's integrity hash),
// unpacks the tarball in memory, checks the package name/version and that the player is really the lottie player, and writes
// the three files above. Running it again with the same version changes nothing.
//
// Needs Node 18+, npm and internet access. It is run by the "Vendor Lottie runtime" GitHub workflow (one tap in the Actions
// tab, it commits the files for you) or by hand. Only Node.js built-ins are used.
//
// Environment (all optional):
//   LOTTIE_TARBALL=/path/to/lottie-web-5.12.2.tgz   use this tarball instead of downloading (offline use, tests)
//   LOTTIE_SHA256=<hex>                              refuse to continue unless the player file has exactly this sha256
// ---------------------------------------------------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '5.12.2';                       // the version the animation JSON was exported for ("v": "5.12.2")
const PLAYER = 'package/build/player/lottie_svg.min.js';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.VENDOR_LOTTIE_REPO || process.env.GITHUB_WORKSPACE || path.resolve(HERE, '..');
const OUT = path.join(REPO, 'assets', 'vendor', 'lottie');

const die = (m) => { console.error('vendor-lottie: ' + m); process.exit(1); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- 1. get the tarball ----
let tarball = process.env.LOTTIE_TARBALL ? path.resolve(process.env.LOTTIE_TARBALL) : null;
let integrity = null;
if (!tarball) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lottie-pack-'));
  try {
    const out = execFileSync('npm', ['pack', `lottie-web@${VERSION}`, '--json'], { cwd: tmp, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
    const info = JSON.parse(out)[0];
    tarball = path.join(tmp, info.filename);
    integrity = info.integrity || null;
  } catch (e) { die(`could not download lottie-web@${VERSION} with npm (${e.message.split('\n')[0]}). Is there an internet connection?`); }
}
if (!fs.existsSync(tarball)) die(`tarball not found: ${tarball}`);

// ---- 2. read it (a tarball is a gzip of 512-byte-block records; only plain files are needed) ----
function untar(buf) {
  const files = new Map();
  let off = 0, paxPath = null;
  const cstr = (b) => b.toString('utf8').replace(/\0[\s\S]*$/, '');
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = cstr(h.subarray(0, 100));
    const prefix = cstr(h.subarray(345, 500));
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    off += 512;
    const body = buf.subarray(off, off + size);
    if (type === 'x') {                                            // PAX extended header: may carry the real path of the next entry
      const m = /\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      paxPath = m ? m[1] : null;
    } else if (type === '0' || type === '\0') {
      files.set(paxPath || name, body);
      paxPath = null;
    }
    off += Math.ceil(size / 512) * 512;
  }
  return files;
}
let files;
try { files = untar(zlib.gunzipSync(fs.readFileSync(tarball))); } catch (e) { die(`could not read the tarball: ${e.message}`); }

// ---- 3. verify ----
const pkgRaw = files.get('package/package.json');
if (!pkgRaw) die('package/package.json is not in the tarball');
const pkg = JSON.parse(pkgRaw.toString('utf8'));
if (pkg.name !== 'lottie-web' || pkg.version !== VERSION) die(`expected lottie-web@${VERSION}, the tarball contains ${pkg.name}@${pkg.version}`);

const player = files.get(PLAYER);
if (!player) die(`${PLAYER} is not in the tarball`);
if (player.length < 50 * 1024) die(`${PLAYER} is only ${player.length} bytes - that is not the lottie player`);
if (!player.toString('utf8').includes('loadAnimation')) die(`${PLAYER} does not look like the lottie player (no loadAnimation)`);
const playerSha = sha256(player);
if (process.env.LOTTIE_SHA256 && process.env.LOTTIE_SHA256.toLowerCase() !== playerSha) die(`sha256 mismatch: expected ${process.env.LOTTIE_SHA256}, got ${playerSha}`);

// npm always packs a top-level LICENSE / LICENCE / COPYING file whatever its case or extension
const licensePath = [...files.keys()].find((n) => /^package\/(license|licence|copying)(\.[a-z]+)?$/i.test(n));
if (!licensePath) die('no license file in the package - the license has to be kept next to the code, so nothing is written');
const license = files.get(licensePath);

// ---- 4. write ----
const meta = {
  name: 'lottie-web',
  version: VERSION,
  build: 'lottie_svg.min.js',
  source: `npm:lottie-web@${VERSION} (build/player/lottie_svg.min.js)`,
  license: pkg.license || 'MIT',
  licenseFile: 'LICENSE.md',
  sha256: playerSha,
  bytes: player.length,
  npmIntegrity: integrity,
  vendoredBy: 'android-build/vendor-lottie.mjs'
};
const metaText = JSON.stringify(meta, null, 2) + '\n';

const target = {
  'lottie_svg.min.js': player,
  'LICENSE.md': license,
  'VERSION.json': Buffer.from(metaText)
};
fs.mkdirSync(OUT, { recursive: true });
let changed = 0;
for (const [name, data] of Object.entries(target)) {
  const file = path.join(OUT, name);
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === sha256(data)) continue;
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
  changed++;
}
console.log(`lottie-web ${VERSION}  lottie_svg.min.js  ${player.length} bytes  sha256 ${playerSha}`);
console.log(changed ? `written to ${path.relative(REPO, OUT).split(path.sep).join('/')}/ (${changed} file(s) changed)` : 'already up to date - nothing changed');
