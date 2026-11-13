'use strict';

/**
 * Update checks against GitHub Releases.
 *
 * Why not electron-updater / Squirrel: Squirrel.Mac refuses to swap in a bundle
 * whose code signature does not match, and these builds are unsigned. So the
 * honest behaviour here is:
 *
 *   check  -> GitHub Releases API
 *   notify -> banner in the window
 *   fetch  -> download the DMG / setup.exe into the user's Downloads folder
 *   install-> open it (macOS: drag to Applications, Windows: run the installer)
 *
 * A signed build could replace the last step with a silent in-place update.
 */

const fs = require('node:fs');

// Electron's net.fetch goes through Chromium's network stack, so it honours
// the system proxy (Clash, Surge, a company proxy…) exactly like a browser.
// Node's own fetch/https ignore it, which made checks or downloads fail for
// people who can only reach GitHub through a proxy. Outside Electron (tests)
// fall back to the global fetch.
function netFetch(url, options) {
  try {
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net.fetch(url, options);
  } catch {
    /* not running inside Electron */
  }
  return fetch(url, options);
}

// DUNG_UPDATE_REPO lets tests point the check at another repo.
const REPO = process.env.DUNG_UPDATE_REPO || 'xfanwu/dung';

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

async function checkForUpdates({ currentVersion, repo = REPO } = {}) {
  const response = await netFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dung',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404) {
    return { ok: true, currentVersion, updateAvailable: false, reason: 'no releases published' };
  }

  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub is limiting update checks from your network right now. Try again later.');
  }

  if (!response.ok) {
    throw new Error(`GitHub API responded ${response.status}`);
  }

  const release = await response.json();
  const latestVersion = String(release.tag_name || '').replace(/^v/, '');

  return {
    ok: true,
    currentVersion,
    latestVersion,
    updateAvailable: isNewer(latestVersion, currentVersion),
    notes: release.body || '',
    pageUrl: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    })),
  };
}

/**
 * Picks the installer a human would want on this platform.
 */
function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const list = assets || [];

  if (platform === 'darwin') {
    const dmgs = list.filter((asset) => asset.name.toLowerCase().endsWith('.dmg'));
    return dmgs.find((asset) => asset.name.includes(arch)) || dmgs[0] || null;
  }

  if (platform === 'win32') {
    const setups = list.filter((asset) => /setup.*\.exe$/i.test(asset.name));
    if (setups.length) {
      return setups.find((asset) => asset.name.includes(arch)) || setups[0];
    }
    return list.find((asset) => asset.name.toLowerCase().endsWith('.exe')) || null;
  }

  return null;
}

/**
 * Downloads to `destination` through the same proxy-aware stack. Writes to
 * `destination + '.part'` and renames at the end, so a failed download never
 * leaves a half installer that looks complete. Gives up if no bytes arrive
 * for `stallMs` (a blocked or stuck connection), with a message that says so.
 */
async function downloadFile(url, destination, { onProgress, stallMs = 30000 } = {}) {
  const controller = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };

  const partial = `${destination}.part`;
  arm();
  try {
    const response = await netFetch(url, {
      headers: { 'user-agent': 'dung', accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);

    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    const file = fs.createWriteStream(partial);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        received += value.length;
        if (!file.write(Buffer.from(value))) await new Promise((r) => file.once('drain', r));
        if (onProgress) onProgress(received, total);
      }
    } finally {
      await new Promise((resolve) => file.end(resolve));
    }
    if (total && received !== total) throw new Error(`download was cut off (${received} of ${total} bytes)`);

    fs.renameSync(partial, destination);
    return { path: destination, bytes: received };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    if (stalled) throw new Error('The download stalled — GitHub may be blocked or slow on your network.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkForUpdates, pickAsset, downloadFile, isNewer, parseVersion, REPO };
