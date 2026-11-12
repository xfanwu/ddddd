'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Aria2 = require('./aria2');
const { findAria2 } = Aria2;
const { installAria2 } = require('./installer');
const { resolveX, isXUrl } = require('./resolvers/x');
const { checkForUpdates, pickAsset, downloadFile } = require('./updater');
const { isExtractorUrl, findYtDlp, downloadUrl: ytdlpDownloadUrl, probe, startDownload, safeName } = require('./ytdlp');
const { classify } = require('./routing');

const pkg = require('../../package.json');
app.setName(pkg.productName || pkg.name);

const DEFAULTS = {
  dir: '',
  connections: 4,
  split: 4,
  globalLimit: '0',
  verifyDmg: true,
  aria2Path: '',
  ytdlpPath: '',
};

let settings = { ...DEFAULTS };
let history = [];
let aria = null;
let win = null;
let quitting = false;
let engineRestarts = 0;
let lastStatus = { ok: false, error: 'engine not started', info: { running: false } };

const verified = new Set();
const verifying = new Set();

const file = (name) => path.join(app.getPath('userData'), name);

function readJson(target, fallback) {
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(target, data) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[state] failed to save ${target}:`, err.message);
  }
}

function writeLog(line) {
  try {
    fs.appendFileSync(file('engine.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the app */
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const settingsItem = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => send('ui:open-settings'),
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: isMac
        ? [{ role: 'close' }]
        : [settingsItem, { type: 'separator' }, { role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Home', accelerator: 'CmdOrCtrl+1', click: () => send('ui:view', 'home') },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+2',
          click: () => send('ui:view', 'history'),
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: isMac
        ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
        : [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    backgroundColor: '#f1f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message) => {
    writeLog(`[renderer:${level}] ${message}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    writeLog(`[renderer] gone: ${JSON.stringify(details)}`);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // The engine usually boots before the renderer subscribes, so replay the
  // current status once the page is live.
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isDestroyed()) win.webContents.send('engine:status', lastStatus);
  });

  win.on('closed', () => {
    win = null;
  });

  if (process.env.SMOKE_TEST) {
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.log(`[smoke] PRELOAD ERROR ${preloadPath}: ${error.message}`);
    });
    win.webContents.on('console-message', (_event, level, message) => {
      console.log(`[smoke] renderer(${level}): ${message}`);
    });

    win.webContents.once('did-finish-load', async () => {
      console.log('[smoke] window loaded');
      try {
        if (process.env.SMOKE_DOWNLOAD) await runSmokeDownload();
        if (process.env.SMOKE_SHOWCASE) await runShowcase();
        if (process.env.SMOKE_INSTALL) await runSmokeInstall();
        if (process.env.SMOKE_UPDATE) await runSmokeUpdate();
        if (process.env.SMOKE_UNSUPPORTED) await runSmokeUnsupported();
        if (process.env.SMOKE_PROBE) await runSmokeProbe();
        const probe = await win.webContents.executeJavaScript(`(() => ({
          rows: document.querySelectorAll('.item').length,
          complete: document.querySelectorAll('.item[data-status="complete"]').length,
          name: (document.querySelector('.item .name') || {}).textContent || null,
          badges: [...document.querySelectorAll('.item .badge')].map((b) => b.textContent),
          threads: document.querySelector('#threads-count').textContent,
          engine: document.querySelector('#engine-label').textContent,
          dot: document.querySelector('#status-dot').dataset.state,
          api: typeof window.api,
          engineLog: (document.querySelector('#log') || {}).textContent?.slice(-900) || '',
        }))()`);
        console.log(`[smoke] probe ${JSON.stringify(probe)}`);
        if (process.env.SMOKE_SHOT) {
          const shot = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT, shot.toPNG());
          console.log(`[smoke] screenshot ${process.env.SMOKE_SHOT}`);
        }
        const settingsProbe = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#settings-btn').click();
          const p = document.querySelector('#settings-modal');
          const opened = {
            visible: !p.hidden && getComputedStyle(p).display !== 'none',
            dir: document.querySelector('#set-dir').value,
            connections: document.querySelector('#set-conn').value,
            split: document.querySelector('#set-split').value,
            verify: document.querySelector('#set-verify').checked,
          };
          document.querySelector('#close-settings').click();
          document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }));
          opened.shortcut = !p.hidden;
          return opened;
        })()`);
        console.log(`[smoke] settings ${JSON.stringify(settingsProbe)}`);
        if (process.env.SMOKE_SHOT2) {
          const second = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT2, second.toPNG());
          console.log(`[smoke] screenshot ${process.env.SMOKE_SHOT2}`);
        }
        const nav = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#close-settings').click();
          document.querySelector('#history-btn').click();
          return {
            historyVisible: !document.querySelector('#history-view').hidden,
            homeHidden: document.querySelector('#main-view').hidden,
            current: document.querySelector('#history-btn').getAttribute('aria-current'),
          };
        })()`);
        console.log(`[smoke] nav ${JSON.stringify(nav)}`);
        if (process.env.SMOKE_SHOT3) {
          const third = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT3, third.toPNG());
          console.log(`[smoke] screenshot ${process.env.SMOKE_SHOT3}`);
        }
        console.log('[smoke] OK');
        app.quit();
      } catch (err) {
        console.log(`[smoke] FAIL ${err.message}`);
        try {
          if (aria) await aria.shutdown();
        } catch {
          /* best effort */
        }
        app.exit(1);
      }
    });
  }
}

function probeRenderer(script) {
  return win.webContents.executeJavaScript(script);
}

async function runSmokeInstall() {
  const before = await probeRenderer(`(() => ({
    installHidden: document.querySelector('#install-btn').hidden,
    text: document.querySelector('#error-text').textContent,
    addDisabled: document.querySelector('#add-btn').disabled,
  }))()`);
  console.log(`[smoke] offline state ${JSON.stringify(before)}`);

  await probeRenderer(`document.querySelector('#install-btn').click()`);

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await probeRenderer(`document.querySelector('#status-dot').dataset.state`);
    if (state === 'ready') {
      console.log('[smoke] install recovered engine');
      return;
    }
  }
  throw new Error('install did not bring the engine back');
}


async function runSmokeProbe() {
  const target = process.env.SMOKE_PROBE_URL || 'https://vimeo.com/76979871';
  await probeRenderer(`(() => {
    document.querySelector('#url-input').value = ${JSON.stringify(target)};
    document.querySelector('#add-btn').click();
  })()`);

  // The row must exist before probing finishes.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const during = await probeRenderer(`(() => {
    const row = document.querySelector('.item');
    return row ? { status: row.dataset.status, badge: (row.querySelector('.badge') || {}).textContent } : null;
  })()`);
  console.log(`[smoke] probing ${JSON.stringify(during)}`);
  if (!during || during.status !== 'probing') throw new Error('no immediate waiting state');

  const readRow = () =>
    probeRenderer(`(() => {
      const row = document.querySelector('.item');
      return row ? { status: row.dataset.status, text: row.textContent.trim().slice(0, 160) } : null;
    })()`);

  // The 12s mark is where the row should admit the source is slow.
  await new Promise((resolve) => setTimeout(resolve, 13000));
  const slow = await readRow();
  console.log(`[smoke] after-12s ${JSON.stringify(slow)}`);

  const deadline = Date.now() + 200000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await readRow();
    if (after && (after.status === 'error' || after.status === 'complete')) {
      console.log(`[smoke] probe-result ${JSON.stringify(after).slice(0, 220)}`);
      return;
    }
  }
  throw new Error('probe never settled');
}

async function runSmokeUnsupported() {
  await probeRenderer(`(() => {
    document.querySelector('#url-input').value = 'https://www.youtube.com/watch?v=vDmjw-c_R2k';
    document.querySelector('#add-btn').click();
  })()`);

  await new Promise((resolve) => setTimeout(resolve, 800));

  const state = await probeRenderer(`(() => ({
    hidden: document.querySelector('#modal').hidden,
    heading: document.querySelector('#modal h3').textContent,
    text: document.querySelector('#modal-text').textContent,
    rows: document.querySelectorAll('.item').length,
  }))()`);

  console.log(`[smoke] unsupported ${JSON.stringify(state)}`);
  if (state.hidden) throw new Error('modal did not appear for a YouTube link');
  if (state.rows !== 0) throw new Error('YouTube link was queued anyway');
}

async function runSmokeUpdate() {
  await probeRenderer(`document.querySelector('#settings-btn').click()`);
  await probeRenderer(`document.querySelector('#check-updates').click()`);

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = await probeRenderer(`(() => ({
      note: document.querySelector('#update-note').textContent,
      banner: !document.querySelector('#update-banner').hidden,
      text: document.querySelector('#update-text').textContent,
      button: document.querySelector('#update-download').textContent,
    }))()`);
    if (state.note && !/Checking/.test(state.note)) {
      console.log(`[smoke] update ${JSON.stringify(state)}`);
      if (state.banner && process.env.SMOKE_UPDATE_DOWNLOAD === '1') {
        await runSmokeUpdateDownload();
      }
      return;
    }
  }
  throw new Error('update check did not finish');
}

async function runSmokeUpdateDownload() {
  await probeRenderer(`document.querySelector('#update-download').click()`);

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await probeRenderer(`(() => ({
      button: document.querySelector('#update-download').textContent,
      note: document.querySelector('#update-note').textContent,
    }))()`);
    if (state.button === 'Open installer') {
      console.log(`[smoke] update downloaded ${JSON.stringify(state)}`);
      return;
    }
  }
  throw new Error('update download did not finish');
}

async function runShowcase() {
  const scripts = [
    {
      url: 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-darwin-arm64.tar.gz',
      out: 'node-v22.11.0-darwin-arm64.tar.gz',
    },
    {
      url: 'https://nodejs.org/dist/v22.11.0/node-v22.11.0-headers.tar.gz',
      out: 'node-v22.11.0-headers.tar.gz',
    },
  ];

  for (const item of scripts) {
    await probeRenderer(
      `window.api.add([${JSON.stringify(item.url)}], ${JSON.stringify({ out: item.out })})`
    );
  }

  // Wait until at least one transfer is actually moving, then let the UI settle.
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const moving = await probeRenderer(
      `(() => [...document.querySelectorAll('.item[data-status="active"]')].length)()`
    );
    if (moving > 0) break;
  }

  await new Promise((resolve) => setTimeout(resolve, 3500));
}

async function runSmokeDownload() {
  const dir = path.join(app.getPath('temp'), 'aria2-ui-smoke');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const url = process.env.SMOKE_URL || 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE';
  const options = process.env.SMOKE_URL ? { dir } : { dir, out: `smoke-${Date.now()}.txt` };

  const gid = await probeRenderer(
    `window.api.add([${JSON.stringify(url)}], ${JSON.stringify(options)})`
  );
  console.log(`[smoke] queued via ipc -> ${gid}`);

  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = await probeRenderer(`(() => {
      const item = document.querySelector('.item');
      const live = document.querySelector('.item .badge.accent');
      return { status: item ? item.dataset.status : 'none', live: Boolean(live) };
    })()`);
    if (state.status === 'complete' && state.live) {
      console.log('[smoke] row rendered as complete');
      return;
    }
    if (state.status === 'error') throw new Error('row rendered as error');
  }
  throw new Error('download did not reach complete in time');
}

/* ---------- yt-dlp jobs ---------- */

const jobs = new Map();
const conflicts = new Map();
const hiddenResults = new Set();
let jobSeq = 0;
let conflictSeq = 0;
let lastPayload = { items: [], global: { downloadSpeed: 0, numActive: 0, numWaiting: 0, numStopped: 0 } };
let lastBroadcast = 0;

const FILE_EXISTS = /exists, but a control file\s*\(\*\.aria2\) does not exist/i;

// aria2 reports "file exists but its *.aria2 control file is gone" as a failed
// download. That is a conflict the user should resolve, not an error to show
// and forget: they can cancel, overwrite, or download alongside the file.
function detectConflicts(items) {
  const present = new Set(items.map((item) => item.gid));

  for (const gid of hiddenResults) {
    if (!present.has(gid)) hiddenResults.delete(gid);
  }
  for (const [id, info] of conflicts) {
    if (info.gid && !present.has(info.gid)) conflicts.delete(id);
  }

  for (const item of items) {
    if (conflicts.has(item.gid) || hiddenResults.has(item.gid)) continue;
    if (Number(item.errorCode) !== 13 || !FILE_EXISTS.test(item.errorMessage || '')) continue;

    const dir = item.dir || settings.dir;
    const target = item.path || (item.name ? path.join(dir, item.name) : '');
    if (!target) continue;

    const info = {
      id: item.gid,
      gid: item.gid,
      url: item.url || '',
      name: item.name || path.basename(target),
      path: target,
      dir,
    };

    conflicts.set(item.gid, info);
    writeLog(`[conflict] ${info.name} exists at ${target}`);
    send('download:conflict', info);
  }
}

function conflictFromError(message, url, target) {
  const match = String(message || '').match(/File (.+?) exists, but a control file\s*\(\*\.aria2\) does not exist/i);
  if (!match) return null;

  const targetPath = match[1];
  const id = `c:${(conflictSeq += 1)}`;
  const info = {
    id,
    gid: '',
    url,
    name: path.basename(targetPath),
    path: targetPath,
    dir: path.dirname(targetPath) || target.dir || settings.dir,
  };

  conflicts.set(id, info);
  return info;
}

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;

  for (let i = 1; i < 10000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    const target = path.join(dir, candidate);
    if (!fs.existsSync(target) && !fs.existsSync(`${target}.aria2`)) return candidate;
  }

  return `${stem} (${Date.now()})${ext}`;
}

const STATUS_FOR_ROW = {
  probing: 'probing',
  active: 'active',
  complete: 'complete',
  error: 'error',
};

function externalItems() {
  return [...jobs.values()].map((job) => ({
    gid: job.id,
    status: STATUS_FOR_ROW[job.status] || job.status,
    totalLength: job.total,
    completedLength: Math.round((job.total * job.percent) / 100) || 0,
    downloadSpeed: job.speed,
    connections: 0,
    split: 0,
    maxConnectionPerServer: 0,
    errorCode: job.status === 'error' ? 1 : 0,
    errorMessage: job.error || '',
    dir: job.dir,
    path: job.path || '',
    name: job.name,
    eta: job.eta || '',
    extractor: 'yt-dlp',
    slow: Boolean(job.slow),
  }));
}

function broadcast(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcast < 400) return;
  lastBroadcast = now;

  send('engine:update', {
    items: [
      ...(lastPayload.items || []).filter(
        (item) => !conflicts.has(item.gid) && !hiddenResults.has(item.gid)
      ),
      ...externalItems(),
    ],
    global: lastPayload.global,
    history,
  });
}

function nameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || parsed.hostname).slice(0, 80);
  } catch {
    return 'download';
  }
}

/**
 * A row appears immediately as "detecting", because probing a URL can take up
 * to twelve seconds and silence would look like a broken button.
 */
function createProbeJob(url) {
  const job = {
    id: `yt:${(jobSeq += 1)}`,
    url,
    name: nameFromUrl(url),
    dir: settings.dir,
    status: 'probing',
    slow: false,
    percent: 0,
    speed: 0,
    eta: '',
    total: 0,
    path: '',
    error: '',
    child: null,
    cancelled: false,
  };

  jobs.set(job.id, job);
  broadcast(true);
  return job;
}

async function runExtractorJob(job) {
  const binary = findYtDlp(settings.ytdlpPath, file('bin'));
  if (!binary) throw new Error('yt-dlp not found. It is required for this site.');

  send('engine:log', `[yt-dlp] probing ${job.url}`);

  // Twelve seconds is the point where the UI admits this is taking a while.
  const slowTimer = setTimeout(() => {
    if (job.status !== 'probing') return;
    job.slow = true;
    broadcast(true);
  }, 12000);

  let info;
  try {
    info = await probe(binary, job.url);
  } finally {
    clearTimeout(slowTimer);
  }

  if (job.cancelled) return;

  // yt-dlp's generic extractor happily "handles" any URL by treating it as a
  // direct file. That path belongs to aria2, which resumes and is faster.
  if (String(info.extractor || '').toLowerCase() === 'generic') {
    throw new Error('GENERIC_EXTRACTOR');
  }

  const base = safeName([info.uploader, info.id].filter(Boolean).join('-') || info.id, 'video');

  // SoundCloud and friends are audio-only; writing AAC bytes into a .mp4 name
  // is technically valid but misleading.
  const audioOnly = !info.vcodec || info.vcodec === 'none';
  const out = `${base}.${audioOnly ? 'm4a' : 'mp4'}`;

  job.name = out;
  job.total = Number(info.filesize || info.filesize_approx || 0);
  job.status = 'active';
  broadcast(true);

  const child = startDownload(binary, {
    url: job.url,
    dir: job.dir,
    out,
    onLog: (line) => send('engine:log', line),
    onProgress: (progress) => {
      job.percent = progress.percent;
      job.speed = progress.speed;
      job.eta = progress.eta;
      if (progress.total) job.total = progress.total;
      broadcast();
    },
  });

  job.child = child;

  child.on('close', (code) => {
    job.child = null;
    if (job.cancelled) return;

    const target = path.join(job.dir, out);

    if (code === 0 && fs.existsSync(target)) {
      job.status = 'complete';
      job.percent = 100;
      job.path = target;
      job.total = fs.statSync(target).size;
      recordHistory([{ status: 'complete', path: target, dir: job.dir, name: out, totalLength: job.total }]);
    } else {
      job.status = 'error';
      job.error = `yt-dlp exited with code ${code}`;
    }

    broadcast(true);
  });
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;

  job.cancelled = true;
  if (job.child) job.child.kill('SIGTERM');
  jobs.delete(id);
  broadcast(true);
  return true;
}

function startEngine() {
  if (aria) {
    const previous = aria;
    aria = null;
    previous.shutdown().catch(() => {});
  }

  const engine = new Aria2();
  aria = engine;
  lastStatus = { ok: false, error: 'starting engine…', info: engine.info() };

  engine.on('update', (payload) => {
    if (aria !== engine) return;
    lastPayload = payload;
    recordHistory(payload.items);
    inspectDownloads(payload.items);
    detectConflicts(payload.items);
    broadcast(true);
  });

  engine.on('log', (line) => {
    writeLog(line);
    if (aria === engine) send('engine:log', line);
  });

  engine.on('exit', (info) => {
    if (aria !== engine || quitting) return;

    aria = null;
    lastStatus = {
      ok: false,
      error: `aria2c exited unexpectedly (code ${info.code})`,
      info: engine.info(),
    };
    send('engine:status', lastStatus);

    // One automatic recovery attempt; a missing binary fails in start() instead.
    if (engineRestarts < 2) {
      engineRestarts += 1;
      setTimeout(() => {
        if (!quitting && !aria) startEngine();
      }, 1500);
    }
  });

  return engine
    .start({ ...settings, dir: settings.dir, sessionFile: file('aria2.session') })
    .then((info) => {
      engineRestarts = 0;
      if (aria === engine) {
        lastStatus = { ok: true, info };
        send('engine:status', lastStatus);
      }
      return info;
    })
    .catch((err) => {
      if (aria === engine) {
        lastStatus = { ok: false, error: err.message, info: engine.info() };
        send('engine:status', lastStatus);
      }
      return null;
    });
}

function recordHistory(items) {
  let changed = false;
  for (const item of items) {
    if (item.status !== 'complete' || !item.path) continue;
    const exists = history.some((entry) => entry.path === item.path);
    if (exists) continue;
    history.unshift({
      id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: item.name,
      path: item.path,
      dir: item.dir,
      size: item.totalLength,
      finishedAt: Date.now(),
    });
    changed = true;
  }
  if (changed) {
    history = history.slice(0, 100);
    writeJson(file('history.json'), history);
  }
}

function inspectDownloads(items) {
  // hdiutil is macOS-only; Windows has no equivalent for .dmg images.
  if (process.platform !== 'darwin' || !settings.verifyDmg) return;

  for (const item of items) {
    if (item.status !== 'complete' || !item.path) continue;
    if (!item.path.toLowerCase().endsWith('.dmg')) continue;
    if (verified.has(item.gid) || verifying.has(item.gid)) continue;

    verifying.add(item.gid);
    verifyDiskImage(item)
      .then((result) => {
        verified.add(item.gid);
        send('verify:result', { gid: item.gid, path: item.path, ...result });
      })
      .finally(() => verifying.delete(item.gid));
  }
}

function verifyDiskImage(item) {
  return new Promise((resolve) => {
    const child = spawn('hdiutil', ['verify', item.path]);
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('error', (err) => resolve({ ok: false, detail: err.message }));
    child.on('close', (code) => {
      const corrupt = /INVALID|corrupted|checksum failed/i.test(output);
      if (code === 0 && !corrupt) {
        resolve({ ok: true, detail: 'Checksum verified' });
      } else {
        resolve({ ok: false, detail: corrupt ? 'Image data corrupted - re-download' : `hdiutil exited ${code}` });
      }
    });
  });
}

let installing = false;

ipcMain.handle('engine:install', async () => {
  if (installing) return { ok: false, error: 'An install is already running' };

  installing = true;
  try {
    const result = await installAria2({
      destDir: file('bin'),
      onLog: (line) => send('engine:log', line),
    });

    if (!result.ok) return result;

    const binary = result.binary || findAria2(settings.aria2Path);
    if (!binary) return { ok: false, error: 'aria2c still not found after install' };

    if (settings.aria2Path !== binary) {
      settings.aria2Path = binary;
      writeJson(file('settings.json'), settings);
    }

    await startEngine();
    return { ok: true, binary };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    installing = false;
  }
});

ipcMain.handle('extractor:install', async () => {
  const dest = path.join(file('bin'), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  try {
    send('engine:log', `[yt-dlp] downloading ${ytdlpDownloadUrl()}`);
    await downloadFile(ytdlpDownloadUrl(), dest, {
      onProgress: (received) => {
        if (received % (10 * 1048576) < 65536) send('engine:log', `[yt-dlp] ${(received / 1048576).toFixed(1)} MB`);
      },
    });

    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);

    settings.ytdlpPath = dest;
    writeJson(file('settings.json'), settings);

    return { ok: true, binary: dest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:external', (_event, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

let updateState = { status: 'idle' };
let pendingUpdatePath = null;

async function runUpdateCheck({ manual = false } = {}) {
  updateState = { ...updateState, status: 'checking' };
  send('update:status', updateState);

  try {
    const result = await checkForUpdates({ currentVersion: app.getVersion() });
    updateState = { status: 'done', manual, ...result };
  } catch (err) {
    updateState = { status: 'error', manual, error: err.message, currentVersion: app.getVersion() };
  }

  send('update:status', updateState);
  return updateState;
}

ipcMain.handle('update:check', () => runUpdateCheck({ manual: true }));

ipcMain.handle('update:download', async () => {
  if (!updateState.updateAvailable) {
    return { ok: false, error: 'No update available' };
  }

  const asset = pickAsset(updateState.assets);
  if (!asset) return { ok: false, error: `No installer published for ${process.platform}` };

  const destination = path.join(app.getPath('downloads'), asset.name);

  try {
    let lastSent = 0;
    const result = await downloadFile(asset.url, destination, {
      onProgress: (received, total) => {
        const now = Date.now();
        if (now - lastSent < 400) return;
        lastSent = now;
        send('update:progress', { received, total, percent: total ? (received / total) * 100 : 0 });
      },
    });

    pendingUpdatePath = result.path;
    send('update:progress', { done: true, path: result.path });
    return { ok: true, path: result.path };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:open', async () => {
  if (!pendingUpdatePath) return false;
  await shell.openPath(pendingUpdatePath);
  return true;
});

ipcMain.handle('update:reveal', () => {
  if (!pendingUpdatePath) return false;
  shell.showItemInFolder(pendingUpdatePath);
  return true;
});

ipcMain.handle('state:get', () => ({
  settings,
  history,
  platform: process.platform,
  version: app.getVersion(),
  update: updateState,
  engine: aria ? aria.info() : { running: false },
  status: lastStatus,
}));

ipcMain.handle('settings:update', async (_event, patch) => {
  const previous = settings;
  settings = { ...settings, ...patch };
  if (!settings.dir) settings.dir = app.getPath('downloads');
  writeJson(file('settings.json'), settings);

  // Changing the binary requires a relaunch; everything else can be applied
  // live through aria2.changeGlobalOption, so active downloads survive.
  if ('aria2Path' in patch && patch.aria2Path !== previous.aria2Path) {
    await startEngine();
    return settings;
  }

  if (aria && aria.running) {
    const options = {};
    if ('connections' in patch) options['max-connection-per-server'] = String(settings.connections);
    if ('split' in patch) options.split = String(settings.split);
    if ('globalLimit' in patch) options['max-overall-download-limit'] = String(settings.globalLimit || '0');
    if ('dir' in patch) options.dir = settings.dir;

    if (Object.keys(options).length) {
      try {
        await aria.rpc('aria2.changeGlobalOption', [options]);
      } catch (err) {
        send('engine:log', `changeGlobalOption failed: ${err.message}`);
      }
    }
  }

  return settings;
});

ipcMain.handle('download:add', async (_event, { urls, options }) => {
  if (!aria || !aria.running) throw new Error('Download engine is not running');

  const entries = [];
  const jobIds = [];
  const skipped = [];

  for (const url of urls) {
    const kind = classify(url);

    if (kind === 'youtube') {
      skipped.push(url);
      continue;
    }

    if (kind === 'direct') {
      entries.push({ url, out: options.out });
      continue;
    }

    if (kind === 'x') {
      const resolved = await resolveX(url, (line) => send('engine:log', line));
      for (const item of resolved.items) entries.push({ url: item.url, out: item.out });
      continue;
    }

    // extractor or unknown: show the row right away, then find out.
    const job = createProbeJob(url);

    try {
      await runExtractorJob(job);
      jobIds.push(job.id);
    } catch (err) {
      const unknownToYtDlp =
        kind === 'probe' && /unsupported url|no suitable extractor|GENERIC_EXTRACTOR/i.test(err.message);

      if (unknownToYtDlp) {
        // Not a media page: hand it to aria2 like any other file.
        send('engine:log', `[route] ${url} is not a media page, using aria2`);
        jobs.delete(job.id);
        broadcast(true);
        entries.push({ url });
      } else {
        job.status = 'error';
        job.error = err.message;
        broadcast(true);
      }
    }
  }

  const gids = [];
  const pendingConflicts = [];
  for (const entry of entries) {
    const target = { dir: settings.dir, ...options };
    if (entry.out) target.out = entry.out;

    try {
      gids.push(await aria.add([entry.url], target));
    } catch (err) {
      const conflict = conflictFromError(err.message, entry.url, target);
      if (!conflict) throw err;
      pendingConflicts.push(conflict);
    }
  }

  return { gids, jobs: jobIds, skipped, conflicts: pendingConflicts };
});

ipcMain.handle('download:resolve', async (_event, { id, action }) => {
  const info = conflicts.get(id);
  if (!info) throw new Error('This download conflict is no longer pending');
  if (!aria || !aria.running) throw new Error('Download engine is not running');

  conflicts.delete(id);
  if (info.gid) {
    hiddenResults.add(info.gid);
    await aria.clearResult(info.gid);
  }

  if (action === 'cancel') return { ok: true };
  if (!info.url) throw new Error('Cannot retry this download: its source URL is missing');

  if (action === 'keep-both') {
    const out = uniqueName(info.dir, info.name);
    const newGid = await aria.add([info.url], { dir: info.dir, out });
    return { ok: true, gid: newGid, name: out };
  }

  if (action === 'overwrite') {
    try {
      fs.rmSync(info.path, { force: true });
      fs.rmSync(`${info.path}.aria2`, { force: true });
    } catch (err) {
      throw new Error(`Could not overwrite ${info.name}: ${err.message}`);
    }

    const newGid = await aria.add([info.url], { dir: info.dir, out: info.name });
    return { ok: true, gid: newGid };
  }

  throw new Error(`Unknown conflict action: ${action}`);
});

ipcMain.handle('download:pause', (_event, gid) => aria.pause(gid));

ipcMain.handle('download:resume', (_event, gid) => aria.resume(gid));

ipcMain.handle('download:remove', async (_event, gid) => {
  if (String(gid).startsWith('yt:')) return cancelJob(gid);

  await aria.remove(gid);
  await aria.clearResult(gid);
  verified.delete(gid);
  return true;
});

ipcMain.handle('history:forget', (_event, id) => {
  history = history.filter((entry) => entry.id !== id);
  writeJson(file('history.json'), history);
  return history;
});

ipcMain.handle('history:clear', async () => {
  const finished = (await aria.rpc('aria2.tellStopped', [0, 1000])) || [];
  for (const item of finished) {
    try {
      await aria.rpc('aria2.removeDownloadResult', [item.gid]);
    } catch {
      /* already gone */
    }
  }
  history = [];
  writeJson(file('history.json'), history);
  return true;
});

ipcMain.handle('dialog:dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose download folder',
    defaultPath: settings.dir,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('shell:reveal', (_event, target) => {
  if (!target) return false;
  shell.showItemInFolder(target);
  return true;
});

ipcMain.handle('app:open', (_event, target) => shell.openPath(target));

app.whenReady().then(async () => {
  settings = { ...DEFAULTS, ...readJson(file('settings.json'), {}) };
  history = readJson(file('history.json'), []);

  console.log(`[app] ${app.getName()} · userData: ${app.getPath('userData')}`);
  writeLog(`[app] started, version ${app.getVersion()}`);

  process.on('uncaughtException', (err) => writeLog(`[main] uncaught: ${err.stack || err.message}`));

  if (!settings.dir) settings.dir = app.getPath('downloads');

  buildMenu();
  createWindow();
  await startEngine();

  setTimeout(() => {
    runUpdateCheck().catch((err) => console.error('[update] check failed', err.message));
  }, 8000);

  setInterval(() => {
    runUpdateCheck().catch((err) => console.error('[update] check failed', err.message));
  }, 6 * 60 * 60 * 1000).unref();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', async (event) => {
  if (!aria) return;

  const instance = aria;
  aria = null;
  quitting = true;

  event.preventDefault();
  await instance.shutdown();
  app.quit();
});
