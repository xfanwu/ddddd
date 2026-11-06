'use strict';

/**
 * yt-dlp backend for sites aria2 cannot handle on its own.
 *
 * YouTube, Instagram and friends serve DASH: the video and audio arrive as
 * separate streams that must be muxed, and the URLs are signed and short-lived.
 * aria2 downloads bytes; it does not speak those protocols. yt-dlp does the
 * extraction, the format selection and the merge (via ffmpeg), so for these
 * sites it is the downloader, not a resolver.
 *
 * TikTok is the happy case: it also exposes a progressive MP4, but routing
 * everything through one backend keeps the behaviour predictable.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = [
  /^https?:\/\/(?:www\.|vm\.)?tiktok\.com\//i,
  /^https?:\/\/(?:www\.)?instagram\.com\//i,
  /^https?:\/\/(?:www\.)?vimeo\.com\//i,
  /^https?:\/\/(?:www\.|m\.)?facebook\.com\//i,
  /^https?:\/\/fb\.watch\//i,
  /^https?:\/\/(?:www\.)?twitch\.tv\//i,
  /^https?:\/\/(?:www\.)?bilibili\.com\//i,
];

function isExtractorUrl(url) {
  return SUPPORTED.some((pattern) => pattern.test(String(url || '').trim()));
}

function binaryName() {
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function findYtDlp(preferred, binDir) {
  const name = binaryName();
  const candidates = [
    preferred,
    binDir ? path.join(binDir, name) : null,
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, name)),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function downloadUrl() {
  return process.platform === 'win32'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
}

const PROGRESS = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)(?:\s+at\s+([\d.]+)\s*([KMGT]?i?B)\/s)?(?:\s+ETA\s+([\d:]+))?/i;

function unitToBytes(value, unit) {
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return Number(value) * (scale[unit.toUpperCase()] || 1);
}

function run(binary, args, { onLine, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (onLine) chunk.toString().split('\n').forEach((line) => line && onLine(line));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function probe(binary, url) {
  const args = ['-J', '--no-warnings', '--no-playlist', '--skip-download'];
  args.push(url);

  const result = await run(binary, args, { timeoutMs: 45000 });
  if (result.code !== 0) {
    const line = (result.stderr || '').split('\n').find((entry) => entry.includes('ERROR')) || 'extraction failed';
    const message = line.replace(/^ERROR:\s*/, '').trim();
    if (/private|login required|rate-limit/i.test(message)) {
      throw new Error(`This post is not publicly accessible: ${message}`);
    }

    throw new Error(message);
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('yt-dlp returned unreadable metadata');
  }
}

function safeName(value, fallback = 'video') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Starts a download. Returns the child process so the caller can cancel it.
 *
 * @param {object} options
 * @param {(p: {percent: number, speed: number, eta: string, total: number}) => void} options.onProgress
 */
function startDownload(binary, { url, dir, out, onProgress, onLog }) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '-f',
    'bv*+ba/b',
    '--merge-output-format',
    'mp4',
    '--no-mtime',
    '-o',
    path.join(dir, out),
  ];

  args.push(url);

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const handle = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (!line) continue;

      const match = PROGRESS.exec(line);
      if (match) {
        const percent = Number(match[1]);
        const total = unitToBytes(match[2], match[3]);
        const speed = match[4] ? unitToBytes(match[4], match[5]) : 0;
        onProgress({ percent, total, speed, eta: match[6] || '' });
        continue;
      }

      if (onLog && !/^\s*$/.test(line)) onLog(`[yt-dlp] ${line.trim()}`);
    }
  };

  child.stdout.on('data', handle);
  child.stderr.on('data', handle);

  return child;
}

module.exports = {
  isExtractorUrl,
  findYtDlp,
  downloadUrl,
  binaryName,
  probe,
  startDownload,
  safeName,
};
