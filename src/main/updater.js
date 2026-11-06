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
const https = require('node:https');

const REPO = 'xfanwu/ddddd';

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
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'ddddd',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 404) {
    return { ok: true, currentVersion, updateAvailable: false, reason: 'no releases published' };
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

function downloadFile(url, destination, { onProgress, depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('too many redirects'));

    const request = https.get(
      url,
      { headers: { 'user-agent': 'ddddd', accept: '*/*' } },
      (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          const next = new URL(headers.location, url).toString();
          return downloadFile(next, destination, { onProgress, depth: depth + 1 }).then(resolve, reject);
        }

        if (statusCode !== 200) {
          response.resume();
          return reject(new Error(`download failed with HTTP ${statusCode}`));
        }

        const total = Number(headers['content-length'] || 0);
        let received = 0;

        const file = fs.createWriteStream(destination);

        response.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });

        response.pipe(file);
        file.on('finish', () => file.close(() => resolve({ path: destination, bytes: received })));
        file.on('error', reject);
        response.on('error', reject);
      }
    );

    request.on('error', reject);
  });
}

module.exports = { checkForUpdates, pickAsset, downloadFile, isNewer, parseVersion, REPO };
