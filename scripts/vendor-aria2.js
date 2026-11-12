#!/usr/bin/env node
'use strict';

/**
 * Puts a self-contained aria2c into vendor/bin so electron-builder ships it
 * inside the app (Contents/Resources/bin on macOS, resources\bin on Windows).
 *
 *   node scripts/vendor-aria2.js            # for the current OS
 *   node scripts/vendor-aria2.js --source   # also keep the source tarball in dist/
 *
 * Windows: the official upstream build, checksum-pinned.
 * macOS:   upstream publishes no mac binary, so we compile the pinned source
 *          against system libraries only (Apple TLS, libz), then refuse to
 *          continue if the result links anything outside /usr/lib or /System.
 *
 * aria2 is GPL-2.0-or-later. Dung runs it as a separate program (mere
 * aggregation), so Dung itself stays MIT, but every shipped copy must come
 * with the licence (copied next to the binary) and its source (the tarball,
 * attached to each GitHub release by the build workflow).
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const VERSION = '1.37.0';
const BASE = `https://github.com/aria2/aria2/releases/download/release-${VERSION}`;
const SOURCE = {
  name: `aria2-${VERSION}.tar.xz`,
  sha256: '60a420ad7085eb616cb6e2bdf0a7206d68ff3d37fb5a956dc44242eb2f79b66b',
};
const WIN64 = {
  name: `aria2-${VERSION}-win-64bit-build1.zip`,
  sha256: '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288',
};

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'vendor', 'bin');
const LICENSES = path.join(OUT, 'licenses');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(os.tmpdir(), `dung-aria2-${VERSION}`);

const log = (line) => console.log(`[vendor-aria2] ${line}`);

function sh(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'dung-build' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function fetchPinned({ name, sha256 }) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, name);
  if (!fs.existsSync(dest)) {
    log(`downloading ${name}`);
    await download(`${BASE}/${name}`, `${dest}.part`);
    fs.renameSync(`${dest}.part`, dest);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  if (actual !== sha256) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${name}: sha256 ${actual} does not match pinned ${sha256}`);
  }
  log(`${name} sha256 ok`);
  return dest;
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function resetOutput() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const entry of fs.readdirSync(OUT)) {
    if (entry !== '.gitkeep') fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(LICENSES, { recursive: true });
}

function writeNotice() {
  fs.writeFileSync(
    path.join(LICENSES, 'README.txt'),
    [
      `aria2 ${VERSION} — https://aria2.github.io/`,
      'Copyright (C) Tatsuhiro Tsujikawa and contributors.',
      '',
      'Dung ships an unmodified aria2c and runs it as a separate program.',
      'aria2 is free software under the GNU General Public License, version 2 or later',
      '(see COPYING). Its complete source code for this exact version is attached to',
      'every Dung release on GitHub as ' + SOURCE.name + ', and is also available from',
      `${BASE}/${SOURCE.name}`,
      '',
      'You may replace this aria2c with your own build: Settings → Advanced →',
      'Download helper (aria2) location.',
      '',
    ].join('\n')
  );
}

/* ---------- Windows: official build ---------- */

async function vendorWindows() {
  const zip = await fetchPinned(WIN64);
  const work = path.join(CACHE, 'win');
  freshDir(work);

  if (process.platform === 'win32') {
    sh('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`,
    ]);
  } else {
    sh('unzip', ['-q', zip, '-d', work]);
  }

  const dir = path.join(work, WIN64.name.replace(/\.zip$/, ''));
  resetOutput();
  fs.copyFileSync(path.join(dir, 'aria2c.exe'), path.join(OUT, 'aria2c.exe'));
  for (const name of ['COPYING', 'LICENSE.OpenSSL', 'AUTHORS']) {
    fs.copyFileSync(path.join(dir, name), path.join(LICENSES, name));
  }
  writeNotice();
  log(`vendored ${path.join(OUT, 'aria2c.exe')}`);
}

/* ---------- macOS: build from source against system libraries ---------- */

const CONFIGURE_FLAGS = [
  '--disable-dependency-tracking',
  '--disable-nls',
  '--enable-shared=no',
  '--without-gnutls',
  '--without-openssl',
  '--without-libnettle',
  '--without-libgmp',
  '--without-libgcrypt',
  '--without-libssh2',
  '--without-libcares',
  '--without-sqlite3',
  '--without-libxml2',
  '--without-libexpat',
  '--without-tcmalloc',
  '--without-jemalloc',
  '--with-libz',
];

async function vendorMac() {
  const tarball = await fetchPinned(SOURCE);
  const work = path.join(CACHE, 'mac');
  freshDir(work);
  sh('tar', ['-xf', tarball, '-C', work]);
  const src = path.join(work, `aria2-${VERSION}`);

  const env = {
    ...process.env,
    MACOSX_DEPLOYMENT_TARGET: process.env.MACOSX_DEPLOYMENT_TARGET || '11.0',
    // Never let pkg-config find Homebrew/MacPorts copies: anything it found
    // would become a dylib dependency that does not exist on users' Macs.
    PKG_CONFIG_PATH: '',
    PKG_CONFIG_LIBDIR: '/nonexistent',
    // configure only skips pkg-config when these are non-empty, hence the no-op define.
    ZLIB_CFLAGS: '-DDUNG_SYSTEM_ZLIB',
    ZLIB_LIBS: '-lz',
    CPPFLAGS: '',
    LDFLAGS: process.platform === 'darwin' ? '-Wl,-headerpad_max_install_names' : '',
  };
  if (process.platform !== 'darwin') {
    env.OPENSSL_CFLAGS = '-DDUNG_SYSTEM_OPENSSL';
    env.OPENSSL_LIBS = '-lssl -lcrypto';
  }

  // aria2 1.37 does not compile with no TLS backend at all. macOS uses Apple's
  // built-in TLS; elsewhere (only used to smoke-test this script) use OpenSSL.
  const flags =
    process.platform === 'darwin'
      ? [...CONFIGURE_FLAGS, '--with-appletls']
      : CONFIGURE_FLAGS.map((flag) => (flag === '--without-openssl' ? '--with-openssl' : flag));

  sh('./configure', flags, { cwd: src, env });
  sh('make', [`-j${os.cpus().length}`], { cwd: src, env });

  const built = path.join(src, 'src', 'aria2c');
  sh('strip', [built]);
  checkPortable(built);

  resetOutput();
  fs.copyFileSync(built, path.join(OUT, 'aria2c'));
  fs.chmodSync(path.join(OUT, 'aria2c'), 0o755);
  for (const name of ['COPYING', 'LICENSE.OpenSSL', 'AUTHORS']) {
    fs.copyFileSync(path.join(src, name), path.join(LICENSES, name));
  }
  writeNotice();

  sh(path.join(OUT, 'aria2c'), ['--version']);
  log(`vendored ${path.join(OUT, 'aria2c')}`);
}

function checkPortable(binary) {
  if (process.platform !== 'darwin') return;
  const out = execFileSync('otool', ['-L', binary], { encoding: 'utf8' });
  const libs = out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0])
    .filter(Boolean);
  const foreign = libs.filter((lib) => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/'));
  log(`links: ${libs.join(', ')}`);
  if (foreign.length) {
    throw new Error(`aria2c links libraries users will not have: ${foreign.join(', ')}`);
  }
}

/* ---------- main ---------- */

(async () => {
  const target = process.argv.includes('--win') ? 'win32' : process.argv.includes('--mac') ? 'darwin' : process.platform;

  if (target === 'win32') await vendorWindows();
  else await vendorMac();

  if (process.argv.includes('--source')) {
    fs.mkdirSync(DIST, { recursive: true });
    fs.copyFileSync(await fetchPinned(SOURCE), path.join(DIST, SOURCE.name));
    log(`source kept at ${path.join(DIST, SOURCE.name)}`);
  }
})().catch((err) => {
  console.error(`[vendor-aria2] ${err.message}`);
  process.exit(1);
});
