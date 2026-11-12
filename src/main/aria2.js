'use strict';

/**
 * Thin, opinionated wrapper around an aria2c RPC daemon.
 *
 * Design notes (learned the hard way):
 *  - `--no-conf=true` ignores ~/.aria2/aria2.conf, so a stray `enable-rpc`
 *    or `split=10` in the user's config cannot hijack or corrupt a download.
 *  - The secret is generated per launch and never leaves the main process.
 *  - `completedLength` from the RPC is the source of truth for progress,
 *    because `--file-allocation=none` pre-truncates the file to its final
 *    size on disk.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';
const BINARY_NAME = IS_WIN ? 'aria2c.exe' : 'aria2c';

const NOMINAL_PATHS = IS_WIN
  ? [
      path.join(process.env.LOCALAPPDATA || '', 'aria2', BINARY_NAME),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'aria2', BINARY_NAME),
      path.join(process.env.ProgramData || '', 'chocolatey', 'bin', BINARY_NAME),
      path.join(process.env.USERPROFILE || '', 'scoop', 'shims', BINARY_NAME),
    ]
  : [
      '/opt/homebrew/bin/aria2c',
      '/usr/local/bin/aria2c',
      '/opt/local/bin/aria2c',
      '/usr/bin/aria2c',
    ];

// Debug switch: make only the *first* lookup fail, so the install-then-
// redetect flow can be exercised on a machine that already has aria2.
let forcedMissing = process.env.ARIA2C_FORCE_MISSING === '1';

function findAria2(preferred) {
  if (forcedMissing) {
    forcedMissing = false;
    return null;
  }

  const fromPath = (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, BINARY_NAME));

  const candidates = [
    preferred,
    path.join(process.resourcesPath || '', 'bin', BINARY_NAME),
    ...NOMINAL_PATHS,
    ...fromPath,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function normalize(raw, meta = {}) {
  const file = raw.files && raw.files[0] ? raw.files[0] : {};
  const filePath = file.path || '';
  const uri = (file.uris && file.uris[0] && file.uris[0].uri) || '';
  return {
    gid: raw.gid,
    status: raw.status,
    totalLength: num(raw.totalLength),
    completedLength: num(raw.completedLength),
    downloadSpeed: num(raw.downloadSpeed),
    connections: num(raw.connections),
    split: meta.split || 0,
    maxConnectionPerServer: meta.maxConnectionPerServer || 0,
    errorCode: num(raw.errorCode),
    errorMessage: raw.errorMessage || '',
    dir: raw.dir || '',
    path: filePath,
    url: uri,
    name: filePath ? path.basename(filePath) : decodeURIComponent(uri.split('/').pop() || 'unknown'),
  };
}

class Aria2 extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.binary = null;
    this.port = 0;
    this.secret = crypto.randomBytes(16).toString('hex');
    this.pollTimer = null;
    this.polling = false;
    this.lastError = '';
    this.defaultSplit = 4;
    this.defaultConnections = 4;
    this.meta = new Map();
  }

  get running() {
    return Boolean(this.process && this.process.exitCode === null && !this.process.killed);
  }

  async start(options = {}) {
    if (this.running) return this.info();

    this.binary = findAria2(options.aria2Path);
    if (!this.binary) {
      throw new Error('aria2c not found (the copy bundled with Dung is missing)');
    }

    this.port = await freePort();
    this.lastError = '';

    const connections = clamp(options.connections, 1, 16, 4);
    const split = clamp(options.split, 1, 16, 4);

    this.defaultSplit = split;
    this.defaultConnections = connections;

    const args = [
      '--no-conf=true',
      '--enable-rpc=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${this.port}`,
      `--rpc-secret=${this.secret}`,
      '--rpc-allow-origin-all=false',
      `--dir=${options.dir}`,
      '--file-allocation=none',
      // Never "continue" a file aria2 did not start: with --continue=true a
      // same-named file of the user's is treated as a partial download and
      // overwritten. aria2 still resumes its own downloads from their .aria2
      // control files (and the session); foreign files become a conflict the
      // user decides on.
      '--continue=false',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--summary-interval=0',
      '--console-log-level=warn',
      '--max-concurrent-downloads=5',
      `--max-connection-per-server=${connections}`,
      `--split=${split}`,
      '--min-split-size=8M',
      `--max-overall-download-limit=${options.globalLimit || '0'}`,
      '--check-certificate=true',
      '--follow-torrent=mem',
    ];

    if (options.sessionFile) {
      fs.mkdirSync(path.dirname(options.sessionFile), { recursive: true });
      const hasSession =
        fs.existsSync(options.sessionFile) && fs.statSync(options.sessionFile).size > 0;

      if (hasSession) {
        args.push(`--input-file=${options.sessionFile}`);
      }
      args.push(`--save-session=${options.sessionFile}`, '--save-session-interval=5');
    }

    this.process = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const relay = (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('log', text);
    };
    this.process.stdout.on('data', relay);
    this.process.stderr.on('data', relay);

    this.process.on('exit', (code, signal) => {
      this.stopPolling();
      this.emit('exit', { code, signal });
    });

    await this.waitForRpc();
    this.startPolling();
    return this.info();
  }

  info() {
    return {
      running: this.running,
      binary: this.binary,
      port: this.port,
      pid: this.process ? this.process.pid : null,
    };
  }

  async waitForRpc(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const version = await this.rpc('aria2.getVersion');
        this.emit('log', `aria2 ${version.version} ready on port ${this.port}`);
        return;
      } catch (err) {
        this.lastError = err.message;
        await delay(150);
      }
    }
    throw new Error(`aria2c did not come up: ${this.lastError}`);
  }

  async rpc(method, params = []) {
    const payload = {
      jsonrpc: '2.0',
      id: 'aria2-desktop',
      method,
      params: [`token:${this.secret}`, ...params],
    };

    const response = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // aria2 answers JSON-RPC errors with HTTP 400 *and* a JSON body that says
    // what went wrong; prefer that message over the bare status.
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* not JSON */
    }
    if (!response.ok && !(body && body.error)) {
      throw new Error(`aria2 RPC responded ${response.status}`);
    }
    if (body.error) {
      throw new Error(body.error.message || 'aria2 RPC error');
    }
    return body.result;
  }

  startPolling(interval = 700) {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.tick(), interval);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async tick() {
    if (this.polling || !this.running) return;
    this.polling = true;
    try {
      const [active, waiting, stopped, global] = await Promise.all([
        this.rpc('aria2.tellActive'),
        this.rpc('aria2.tellWaiting', [0, 200]),
        this.rpc('aria2.tellStopped', [0, 200]),
        this.rpc('aria2.getGlobalStat'),
      ]);

      this.emit('update', {
        items: [...active, ...waiting, ...stopped].map((raw) =>
          normalize(raw, this.meta.get(raw.gid) || {
            split: this.defaultSplit,
            maxConnectionPerServer: this.defaultConnections,
          })
        ),
        global: {
          downloadSpeed: num(global.downloadSpeed),
          numActive: num(global.numActive),
          numWaiting: num(global.numWaiting),
          numStopped: num(global.numStopped),
        },
      });
    } catch (err) {
      this.lastError = err.message;
      this.emit('log', `poll failed: ${err.message}`);
    } finally {
      this.polling = false;
    }
  }

  async add(urls, options = {}) {
    const gid = await this.rpc('aria2.addUri', [urls, options]);

    // aria2 does not report per-download split/connection settings through
    // tellStatus, so remember what this download was actually created with.
    this.meta.set(gid, {
      split: num(options.split) || this.defaultSplit,
      maxConnectionPerServer: num(options['max-connection-per-server']) || this.defaultConnections,
    });

    return gid;
  }

  // Pause/Resume race the download itself: it can finish (or already be
  // paused/running) between the click and the call. Those are not errors.
  async statusOf(gid) {
    try {
      return (await this.rpc('aria2.tellStatus', [gid, ['status']])).status;
    } catch {
      return 'gone';
    }
  }

  async pause(gid) {
    try {
      return await this.rpc('aria2.forcePause', [gid]);
    } catch (err) {
      const status = await this.statusOf(gid);
      if (status !== 'active' && status !== 'waiting') return null;
      try {
        return await this.rpc('aria2.pause', [gid]);
      } catch {
        if ((await this.statusOf(gid)) !== 'active') return null;
        throw err;
      }
    }
  }

  async resume(gid) {
    try {
      return await this.rpc('aria2.unpause', [gid]);
    } catch (err) {
      if ((await this.statusOf(gid)) !== 'paused') return null;
      throw err;
    }
  }

  async remove(gid) {
    try {
      return await this.rpc('aria2.forceRemove', [gid]);
    } catch {
      return null;
    }
  }

  async clearResult(gid) {
    try {
      return await this.rpc('aria2.removeDownloadResult', [gid]);
    } catch {
      return null;
    }
  }

  async shutdown() {
    this.stopPolling();
    if (!this.process) return;

    try {
      await Promise.race([this.rpc('aria2.shutdown'), delay(1500)]);
    } catch {
      /* daemon already gone */
    }

    const child = this.process;
    this.process = null;

    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await delay(400);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = Aria2;
module.exports.findAria2 = findAria2;
