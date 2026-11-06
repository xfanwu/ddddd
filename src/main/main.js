'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Aria2 = require('./aria2');
const { findAria2 } = Aria2;
const { installAria2 } = require('./installer');
const { resolveX, isXUrl } = require('./resolvers/x');
const { checkForUpdates, pickAsset, downloadFile } = require('./updater');

const pkg = require('../../package.json');
app.setName(pkg.productName || pkg.name);

const DEFAULTS = {
  dir: '',
  connections: 4,
  split: 4,
  globalLimit: '0',
  verifyDmg: true,
  aria2Path: '',
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

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
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
        const probe = await win.webContents.executeJavaScript(`(() => ({
          rows: document.querySelectorAll('.item').length,
          complete: document.querySelectorAll('.item[data-status="complete"]').length,
          name: (document.querySelector('.item .name') || {}).textContent || null,
          badges: [...document.querySelectorAll('.item .badge')].map((b) => b.textContent),
          threads: document.querySelector('#threads-count').textContent,
          engine: document.querySelector('#engine-label').textContent,
          dot: document.querySelector('#status-dot').dataset.state,
          api: typeof window.api,
        }))()`);
        console.log(`[smoke] probe ${JSON.stringify(probe)}`);
        if (process.env.SMOKE_SHOT) {
          const shot = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT, shot.toPNG());
          console.log(`[smoke] screenshot ${process.env.SMOKE_SHOT}`);
        }
        const panel = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#settings-btn').click();
          const p = document.querySelector('#panel');
          return {
            visible: !p.hidden && getComputedStyle(p).display !== 'none',
            dir: document.querySelector('#set-dir').value,
            connections: document.querySelector('#set-conn').value,
            split: document.querySelector('#set-split').value,
            verify: document.querySelector('#set-verify').checked,
          };
        })()`);
        console.log(`[smoke] panel ${JSON.stringify(panel)}`);
        if (process.env.SMOKE_SHOT2) {
          const second = await win.webContents.capturePage();
          fs.writeFileSync(process.env.SMOKE_SHOT2, second.toPNG());
          console.log(`[smoke] screenshot ${process.env.SMOKE_SHOT2}`);
        }
        console.log('[smoke] OK');
        app.quit();
      } catch (err) {
        console.log(`[smoke] FAIL ${err.message}`);
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

  const deadline = Date.now() + 45000;
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
    recordHistory(payload.items);
    inspectDownloads(payload.items);
    send('engine:update', { ...payload, history });
  });

  engine.on('log', (line) => {
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

  // X posts are HLS pages, not files: expand them into direct MP4 renditions
  // before they reach aria2.
  const entries = [];
  for (const url of urls) {
    if (!isXUrl(url)) {
      entries.push({ url, out: options.out });
      continue;
    }

    const resolved = await resolveX(url, (line) => send('engine:log', line));
    for (const item of resolved.items) entries.push({ url: item.url, out: item.out });
  }

  const gids = [];
  for (const entry of entries) {
    const target = { dir: settings.dir, ...options };
    if (entry.out) target.out = entry.out;
    gids.push(await aria.add([entry.url], target));
  }

  return gids;
});

ipcMain.handle('download:pause', (_event, gid) => aria.pause(gid));

ipcMain.handle('download:resume', (_event, gid) => aria.resume(gid));

ipcMain.handle('download:remove', async (_event, gid) => {
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

  if (!settings.dir) settings.dir = app.getPath('downloads');

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
