'use strict';

/**
 * End-to-end check of the X resolver: status URL -> direct MP4 -> aria2.
 *
 *   node scripts/smoke-x.js [status-url]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Aria2 = require('../src/main/aria2');
const { resolveX } = require('../src/main/resolvers/x');

const url = process.argv[2] || 'https://x.com/blackanger/status/2118043007413104810';

const fatal = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

(async () => {
  const resolved = await resolveX(url, (line) => console.log(`  ${line}`));
  console.log(`PASS resolved ${resolved.items.length} rendition(s) for @${resolved.author}`);

  for (const item of resolved.items) {
    console.log(`  ${item.out} <- ${item.url.slice(0, 90)}…`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-smoke-'));
  const aria = new Aria2();
  await aria.start({ dir, connections: 4, split: 4, globalLimit: '0' });

  const gid = await aria.add([resolved.items[0].url], { out: resolved.items[0].out });
  console.log(`PASS queued gid ${gid}`);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download timed out')), 180000);
    aria.on('update', ({ items }) => {
      const match = items.find((entry) => entry.gid === gid);
      if (!match) return;
      if (match.status === 'complete') {
        clearTimeout(timer);
        resolve(match);
      }
      if (match.status === 'error') {
        clearTimeout(timer);
        reject(new Error(match.errorMessage || `error code ${match.errorCode}`));
      }
    });
  });

  console.log(`PASS downloaded ${result.totalLength} bytes`);

  const target = path.join(dir, resolved.items[0].out);
  if (!fs.existsSync(target)) fatal('file missing on disk');

  const size = fs.statSync(target).size;
  if (size !== result.totalLength) fatal(`size mismatch ${size} vs ${result.totalLength}`);

  const head = fs.readFileSync(target).subarray(0, 12);
  const brand = head.subarray(4, 8).toString('ascii');
  if (brand !== 'ftyp') fatal(`not an MP4 (boxes: ${JSON.stringify(head.toString('ascii'))})`);

  console.log(`PASS valid MP4 container (brand ${head.subarray(8, 12).toString('ascii')}), ${size} bytes`);

  await aria.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
