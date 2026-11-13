'use strict';

/**
 * One-click "Restart to update" without Squirrel.
 *
 * Squirrel.Mac (electron-updater) refuses unsigned apps, and Dung is ad-hoc
 * signed only. So Dung installs its own update:
 *
 *   macOS   mount the downloaded DMG, then a tiny detached script waits for
 *           Dung to quit, copies the new Dung.app over the old one (via a
 *           temporary copy, so a failure leaves the old app intact), removes
 *           the quarantine flag, unmounts and reopens Dung.
 *   Windows run the NSIS installer silently (/S) and let it reopen Dung
 *           (--force-run). Per-user install, so no admin prompt.
 *
 * When that is not possible (portable Windows build, app not writable,
 * running from a DMG, development) the caller falls back to opening the
 * installer or the release page.
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args[0]} failed: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });

/** The running Dung.app bundle on macOS, or null. */
function currentBundle(execPath = process.execPath) {
  const bundle = path.resolve(execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

function writable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bash run after Dung quits: $1 pid to wait for, $2 new app, $3 installed app,
 * $4 DMG mount point. Copies to "$3.updating" first and only then swaps, so a
 * failed copy never leaves the user without an app; always reopens Dung.
 */
const MAC_SCRIPT = `#!/bin/bash
PID="$1"; SRC="$2"; DEST="$3"; MNT="$4"
for i in $(seq 1 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
TMP="$DEST.updating"
rm -rf "$TMP"
if ditto "$SRC" "$TMP"; then
  rm -rf "$DEST" && mv "$TMP" "$DEST"
  xattr -dr com.apple.quarantine "$DEST" 2>/dev/null
else
  rm -rf "$TMP"
fi
hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null
open "$DEST"
`;

async function prepareMac(installer, { execPath = process.execPath } = {}) {
  const dest = currentBundle(execPath);
  if (!dest) return { ok: false, reason: 'not-a-bundle' };
  if (dest.startsWith('/Volumes/')) return { ok: false, reason: 'running-from-dmg' };
  if (!writable(path.dirname(dest)) || !writable(dest)) return { ok: false, reason: 'not-writable' };

  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'dung-update-'));
  await run('hdiutil', ['attach', installer, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
  const app = fs.readdirSync(mount).find((name) => name.endsWith('.app'));
  if (!app) {
    await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
    return { ok: false, reason: 'no-app-in-dmg' };
  }

  const script = path.join(os.tmpdir(), `dung-update-${Date.now()}.sh`);
  fs.writeFileSync(script, MAC_SCRIPT, { mode: 0o755 });
  return { ok: true, command: '/bin/bash', args: [script, String(process.pid), path.join(mount, app), dest, mount] };
}

function prepareWindows(installer) {
  // The portable .exe has no install to update; the caller offers the page.
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { ok: false, reason: 'portable' };
  if (!/setup.*\.exe$/i.test(path.basename(installer))) return { ok: false, reason: 'not-an-installer' };
  return { ok: true, command: installer, args: ['/S', '--force-run'] };
}

/**
 * Works out how to install `installer` over the running app. Returns
 * { ok: true, command, args } to launch (detached) right before quitting, or
 * { ok: false, reason }.
 */
async function prepareUpdate(installer, { platform = process.platform, isPackaged = true, execPath } = {}) {
  if (!isPackaged) return { ok: false, reason: 'development' };
  if (!installer || !fs.existsSync(installer)) return { ok: false, reason: 'missing-installer' };
  if (platform === 'darwin') return prepareMac(installer, { execPath });
  if (platform === 'win32') return prepareWindows(installer);
  return { ok: false, reason: 'unsupported-platform' };
}

function launchDetached({ command, args }) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

module.exports = { prepareUpdate, launchDetached, currentBundle, MAC_SCRIPT };
