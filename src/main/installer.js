'use strict';

/**
 * Gets an aria2c binary onto the machine.
 *
 * Normally nothing here runs: release builds ship aria2c inside the app (see
 * scripts/vendor-aria2.js). This is the *repair* path for when that copy is
 * gone, e.g. Windows antivirus quarantined aria2c.exe.
 *
 * Windows: re-download the official zip and unpack it into the app's support
 *          directory.
 * macOS:   upstream ships no mac binary, so the fix is reinstalling Dung.
 *
 * Nothing here depends on Electron, so it can be tested with plain node.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const BINARY_NAME = IS_WIN ? 'aria2c.exe' : 'aria2c';

const ARIA2_VERSION = '1.37.0';

function aria2WindowsUrl() {
  const flavour = process.arch === 'ia32' ? 'win-32bit' : 'win-64bit';
  return `https://github.com/aria2/aria2/releases/download/release-${ARIA2_VERSION}/aria2-${ARIA2_VERSION}-${flavour}-build1.zip`;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, onLog, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });

    const relay = (chunk) => {
      const text = chunk.toString().trim();
      if (text) onLog(text);
    };

    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code}`));
    });
  });
}

/**
 * Downloads a URL to a file, following redirects and reporting progress.
 */
function download(url, destination, onLog, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));

    const request = https.get(
      url,
      { headers: { 'user-agent': 'dung', accept: '*/*' } },
      (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          const next = new URL(headers.location, url).toString();
          return download(next, destination, onLog, depth + 1).then(resolve, reject);
        }

        if (statusCode !== 200) {
          response.resume();
          return reject(new Error(`download failed with HTTP ${statusCode}`));
        }

        const total = Number(headers['content-length'] || 0);
        let received = 0;
        let lastReport = 0;

        const file = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (onLog && now - lastReport > 1500) {
            lastReport = now;
            const pct = total ? ` (${Math.round((received / total) * 100)}%)` : '';
            onLog(`downloading ${(received / 1048576).toFixed(1)} MB${pct}`);
          }
        });

        response.pipe(file);
        file.on('finish', () => file.close(() => resolve(destination)));
        file.on('error', reject);
        response.on('error', reject);
      }
    );

    request.on('error', reject);
  });
}

function walkForBinary(dir, target, depth = 0) {
  if (depth > 3) return null;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === target) return full;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = walkForBinary(path.join(dir, entry.name), target, depth + 1);
    if (found) return found;
  }

  return null;
}

async function installForWindows({ destDir, onLog }) {
  const url = aria2WindowsUrl();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dung-aria2-'));

  try {
    const zip = path.join(work, 'aria2.zip');
    onLog(`[install] fetching ${url}`);
    await download(url, zip, onLog);

    const unpack = path.join(work, 'unpacked');
    fs.mkdirSync(unpack, { recursive: true });

    onLog('[install] extracting archive');
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${unpack}' -Force`,
      ],
      onLog
    );

    const found = walkForBinary(unpack, BINARY_NAME);
    if (!found) throw new Error('aria2c.exe was not present in the archive');

    const sourceDir = path.dirname(found);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy the whole folder so any sibling DLLs come along.
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(destDir, entry.name));
    }

    const installed = path.join(destDir, BINARY_NAME);
    if (!fs.existsSync(installed)) throw new Error('could not install aria2c.exe');

    onLog(`[install] installed to ${installed}`);
    return { ok: true, binary: installed };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * @returns {Promise<{ok: boolean, binary?: string, error?: string, reason?: string}>}
 */
async function installAria2({ destDir, onLog = () => {} }) {
  if (IS_WIN) {
    try {
      const result = await installForWindows({ destDir, onLog });
      if (result.ok) return { ...result, binary: result.binary || path.join(destDir, BINARY_NAME) };
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  if (process.platform === 'darwin') {
    onLog('[install] no upstream mac build; reinstall Dung to restore the bundled aria2c');
    return {
      ok: false,
      reason: 'reinstall',
      error: 'The aria2c bundled with Dung is missing. Reinstall Dung to restore it.',
    };
  }

  return {
    ok: false,
    reason: 'unsupported',
    error: `Automatic install is not supported on ${process.platform}. Install aria2 with your package manager.`,
  };
}

module.exports = { installAria2, BINARY_NAME, isExecutable, aria2WindowsUrl };
