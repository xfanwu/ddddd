'use strict';

/**
 * Headless check of the aria2 wrapper: spawn the daemon, queue a real
 * download, watch it finish, confirm the bytes landed on disk.
 *
 *   node scripts/smoke-engine.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Aria2 = require('../src/main/aria2');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aria2-smoke-'));
const out = 'node-license.txt';
const url = 'https://raw.githubusercontent.com/nodejs/node/main/LICENSE';

const fatal = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

(async () => {
  const aria = new Aria2();

  aria.on('log', (line) => console.log(`  [engine] ${line}`));

  const info = await aria.start({
    dir,
    connections: 4,
    split: 4,
    globalLimit: '0',
    sessionFile: path.join(dir, 'session.txt'),
  });

  console.log(`PASS engine started (pid ${info.pid}, port ${info.port})`);
  console.log(`  binary: ${info.binary}`);

  const version = await aria.rpc('aria2.getVersion');
  console.log(`PASS rpc reachable, aria2 ${version.version}`);

  const gid = await aria.add([url], { out });
  console.log(`PASS queued gid ${gid}`);

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('download timed out')), 60000);
    aria.on('update', ({ items }) => {
      const match = items.find((item) => item.gid === gid);
      if (!match) return;
      if (match.status === 'complete') {
        clearTimeout(timeout);
        resolve(match);
      }
      if (match.status === 'error') {
        clearTimeout(timeout);
        reject(new Error(`download failed: ${match.errorMessage}`));
      }
    });
  });

  console.log(`PASS download complete (${result.totalLength} bytes)`);

  const target = path.join(dir, out);
  if (!fs.existsSync(target)) fatal('file missing on disk');

  const size = fs.statSync(target).size;
  if (size !== result.totalLength) fatal(`size mismatch: disk ${size} vs aria2 ${result.totalLength}`);
  console.log(`PASS bytes on disk match (${size})`);

  const pauseGid = await aria.add(['https://raw.githubusercontent.com/nodejs/node/main/README.md'], {
    out: 'node-readme.md',
  });
  await aria.pause(pauseGid);
  await new Promise((r) => setTimeout(r, 400));
  const paused = (await aria.rpc('aria2.tellStatus', [pauseGid])).status;
  if (paused !== 'paused') fatal(`pause did not take effect (status ${paused})`);
  console.log('PASS pause works');

  await aria.resume(pauseGid);
  console.log('PASS resume works');

  await aria.remove(pauseGid);
  await aria.clearResult(pauseGid);
  console.log('PASS remove works');

  await aria.shutdown();

  const alive = aria.process !== null;
  if (alive) fatal('daemon still alive after shutdown');
  console.log('PASS shutdown clean');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
