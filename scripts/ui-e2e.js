#!/usr/bin/env node
'use strict';

/**
 * Renderer flow test: loads the real index.html in headless Chromium with a
 * scripted window.api, replays the situations that matter end to end, and
 * checks what the screen shows.
 *
 *   node scripts/ui-e2e.js        (needs Playwright: npm i -D playwright && npx playwright install chromium)
 *
 * Covers: pasting while Dung is waking up, restored results at launch, the
 * finish screen, switching downloads without the beetle rolling backwards,
 * lanes (and keeping them across a History visit), Done, crash recovery,
 * the missing-binary path, and Escape on dialogs.
 */

const { chromium } = require('playwright');
const R = require('node:path').resolve(__dirname, '..');
let failures = 0;
const check = (name, ok, extra='') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failures++; };
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 900, height: 620 } });
  p.on('pageerror', e => { console.log('PAGEERROR', e.message); failures++; });
  await p.addInitScript(() => {
    window.__now = 1_000_000; Date.now = () => window.__now;
    const subs = {}; window.__calls = [];
    const sub = (k) => (fn) => { subs[k] = fn; };
    window.__emit = (k, v) => subs[k] && subs[k](v);
    window.api = { platform: 'darwin',
      getState: () => Promise.resolve({ version: '1.5.0', settings: { dir: '/d' }, history: [], status: { ok: false, error: 'starting engine…' } }),
      add: (urls) => { window.__calls.push(['add', urls]); return Promise.resolve({ gids: ['x'] }); },
      remove: (g) => { window.__calls.push(['remove', g]); return Promise.resolve(true); },
      restartEngine: () => { window.__calls.push(['restart']); return Promise.resolve({ ok: true }); },
      installEngine: () => { window.__calls.push(['install']); return Promise.resolve({ ok: false, reason: 'reinstall' }); },
      openExternal: (u) => { window.__calls.push(['external', u]); },
      onUpdate: sub('update'), onStatus: sub('status'), onUpdateStatus: sub('us'), onUpdateProgress: sub('up'),
      onOpenSettings: sub('os'), onView: sub('view'), onConflict: sub('conflict'), onVerify: sub('verify'), onLog: sub('log'),
    };
    // drop view transitions in this harness so DOM updates are synchronous
    document.startViewTransition = undefined;
  });
  await p.goto('file://' + R + '/src/renderer/index.html');
  await p.waitForTimeout(300);
  const ev = (fn, arg) => p.evaluate(fn, arg);
  const mode = () => ev(() => document.querySelector('.app').dataset.mode);
  const item = (gid, status, done=0, total=100, extra={}) => ({ gid, status, name: gid + '.bin', path: '/d/' + gid + '.bin', totalLength: total, completedLength: done, downloadSpeed: status==='active'?10:0, connections: 4, ...extra });
  const update = (items, advanceMs=0) => ev(([items, ms]) => { window.__now += ms; window.__emit('update', { items, history: [] }); }, [items, advanceMs]);

  // 1. Paste while waking up -> queued, then sent when ready
  await ev(() => { document.querySelector('#url-input').value = 'https://e.com/a.bin'; document.querySelector('#url-input').dispatchEvent(new Event('paste')); });
  await p.waitForTimeout(50);
  check('paste while waking up does not call add', (await ev(() => window.__calls.filter(c=>c[0]==='add').length)) === 0);
  check('no error banner while waking up', await ev(() => document.querySelector('#error-banner').hidden));
  await ev(() => window.__emit('status', { ok: true, info: {} }));
  await p.waitForTimeout(50);
  check('queued link sent once ready', (await ev(() => JSON.stringify(window.__calls.filter(c=>c[0]==='add')))) === '[["add",["https://e.com/a.bin"]]]');

  // 2. Restored finished items at launch are old news
  await update([item('old1', 'complete', 100), item('old2', 'complete', 100)]);
  check('restored finished items -> idle', (await mode()) === 'idle', await mode());
  check('no "+N more" for old finished items', await ev(() => document.querySelector('#others-link').hidden));

  // 3. One download runs, then finishes; finish screen stays
  await update([item('A', 'active', 30), item('old1', 'complete', 100), item('old2', 'complete', 100)], 500);
  check('one running -> active', (await mode()) === 'active');
  check('shows A', (await ev(() => document.querySelector('#current-name').textContent)) === 'A.bin');
  await update([item('old1', 'complete', 100), item('old2', 'complete', 100), item('A', 'complete', 100)], 500);
  check('A finished -> still active with Open', (await mode()) === 'active' && (await ev(() => !!document.querySelector('#stage-actions [data-action="open"]'))));
  check('finish shows A (not an older item)', (await ev(() => document.querySelector('#current-name').textContent)) === 'A.bin');
  await update([item('old1', 'complete', 100), item('old2', 'complete', 100), item('A', 'complete', 100)], 20000);
  check('finish screen still there after 20s', (await ev(() => document.querySelector('#current-name').textContent)) === 'A.bin');

  // 4. New download replaces it, beetle snaps to 0 instead of rolling back
  await update([item('B', 'active', 5), item('old1', 'complete', 100), item('A', 'complete', 100)], 500);
  check('new download B takes over', (await ev(() => document.querySelector('#current-name').textContent)) === 'B.bin');
  const p0 = await ev(() => document.querySelector('#progress')._s.p);
  check('beetle snapped near 0 (no backwards roll)', p0 < 0.1, `p=${p0.toFixed(2)}`);

  // 5. Second download -> lanes; A (finished 20s ago) not a lane
  await update([item('B', 'active', 20), item('C', 'waiting', 0), item('A', 'complete', 100)], 500);
  check('two running -> lanes', (await mode()) === 'lanes');
  check('lanes are B and C only', (await ev(() => [...document.querySelectorAll('.lane')].map(l=>l.dataset.gid).join())) === 'C,B' || (await ev(() => [...document.querySelectorAll('.lane')].map(l=>l.dataset.gid).join())) === 'B,C', await ev(() => [...document.querySelectorAll('.lane')].map(l=>l.dataset.gid).join()));

  // 6. History and back keeps lane beetles
  await ev(() => { document.querySelector('.lane[data-gid="B"]').__marker = 'same'; });
  await ev(() => document.querySelector('#history-btn').click());
  await update([item('B', 'active', 25), item('C', 'waiting', 0), item('A', 'complete', 100)], 500);
  await ev(() => document.querySelector('#home-btn').click());
  check('lane B is the same element after History', (await ev(() => document.querySelector('.lane[data-gid="B"]').__marker)) === 'same');
  const pB = await ev(() => document.querySelector('.lane[data-gid="B"] dung-progress')._s.p);
  check('lane B started at its real progress, not 0', pB >= 0.19, `p=${pB.toFixed(2)}`);

  // 7. B finishes -> lane lingers, then folds into active(C)
  await update([item('C', 'active', 10), item('B', 'complete', 100), item('A', 'complete', 100)], 500);
  check('B finished: still lanes (B lingers)', (await mode()) === 'lanes');
  await update([item('C', 'active', 40), item('B', 'complete', 100), item('A', 'complete', 100)], 9000);
  check('after linger: single active C', (await mode()) === 'active' && (await ev(() => document.querySelector('#current-name').textContent)) === 'C.bin');

  // 8. Done removes the finished item
  await update([item('C', 'complete', 100), item('B', 'complete', 100), item('A', 'complete', 100)], 500);
  await ev(() => document.querySelector('#stage-actions [data-action="remove"]').click());
  await p.waitForTimeout(30);
  check('Done calls remove(C)', (await ev(() => JSON.stringify(window.__calls.at(-1)))) === '["remove","C"]');
  await update([item('B', 'complete', 100), item('A', 'complete', 100)], 500);
  check('after Done: falls back to B (most recent other finish)', (await ev(() => document.querySelector('#current-name').textContent)) === 'B.bin');

  // 9. Crash -> Try again restarts (not reinstall)
  await ev(() => window.__emit('status', { ok: false, error: 'aria2c exited unexpectedly (code 1)' }));
  check('crash shows recovery card', !(await ev(() => document.querySelector('#setup-card').hidden)));
  await ev(() => document.querySelector('#install-btn').click()); await p.waitForTimeout(30);
  check('Try again restarts the engine', (await ev(() => JSON.stringify(window.__calls.at(-1)))) === '["restart"]');
  await ev(() => window.__emit('status', { ok: true, info: {} }));
  check('card hides when engine is back', await ev(() => document.querySelector('#setup-card').hidden));

  // 10. Missing binary on mac -> Get Dung again opens releases
  await ev(() => window.__emit('status', { ok: false, error: 'aria2c not found (the copy bundled with Dung is missing)' }));
  await ev(() => document.querySelector('#install-btn').click()); await p.waitForTimeout(30);
  check('missing on mac opens releases page', (await ev(() => window.__calls.at(-1)[0])) === 'external');

  // 11. Escape closes unsupported modal
  await ev(() => showUnsupported());
  await p.keyboard.press('Escape');
  check('Escape closes Not supported', await ev(() => document.querySelector('#modal').hidden));

  await b.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
