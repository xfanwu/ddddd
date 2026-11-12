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
      updateSettings: (patch) => { window.__calls.push(['settings', patch]); return Promise.resolve({ dir: '/d', ...patch }); },
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
  await update([]);
  check('nothing running -> idle', (await mode()) === 'idle', await mode());
  check('no "+N more" when idle', await ev(() => document.querySelector('#others-link').hidden));

  // 3. One download runs, then finishes; finish screen stays
  await update([item('old1', 'complete', 100), item('old2', 'complete', 100)], 500); // finished long ago
  await update([item('A', 'active', 30), item('old1', 'complete', 100), item('old2', 'complete', 100)], 20000);
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
  await ev(() => document.querySelector('#door-handle').click());
  await update([item('B', 'active', 25), item('C', 'waiting', 0), item('A', 'complete', 100)], 500);
  await ev(() => document.querySelector('#door-handle').click());
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

  // 12. Finishing download missing from one poll: no flash to idle, no beetle replay
  await ev(() => window.__emit('status', { ok: true, info: {} }));
  await update([], 500);
  await update([item('F', 'active', 90)], 500);
  await ev(() => { window.__modes = []; new MutationObserver(() => window.__modes.push(document.querySelector('.app').dataset.mode)).observe(document.querySelector('.app'), { attributes: true, attributeFilter: ['data-mode'] }); });
  await update([], 400); // the in-between poll
  check('vanishing finisher keeps Home on it (no idle flash)', (await mode()) === 'active' && (await ev(() => document.querySelector('#current-name').textContent)) === 'F.bin');
  await update([item('F', 'complete', 100)], 400);
  check('no idle flash recorded during finish', !(await ev(() => window.__modes.includes('idle'))), await ev(() => window.__modes.join(',')));

  // 13. Buttons are not rebuilt on every progress tick
  await update([item('G', 'active', 10), item('F', 'complete', 100)], 500);
  await ev(() => { document.querySelector('#stage-actions').firstElementChild.__marker = 'kept'; });
  await update([item('G', 'active', 20), item('F', 'complete', 100)], 500);
  await update([item('G', 'active', 30), item('F', 'complete', 100)], 500);
  check('stage buttons untouched by progress updates', (await ev(() => document.querySelector('#stage-actions').firstElementChild.__marker)) === 'kept');

  // 14. Pasting a link that is already downloading shows a calm note
  await ev(() => { window.api.add = () => Promise.resolve({ gids: [], jobs: [], duplicates: ['https://e.com/g.bin'] }); });
  await ev(() => { document.querySelector('#url-input').value = 'https://e.com/g.bin'; document.querySelector('#url-input').dispatchEvent(new Event('paste')); });
  await p.waitForTimeout(60);
  check('duplicate paste -> calm "already rolling" note', await ev(() => !document.querySelector('#error-banner').hidden && document.querySelector('#error-banner').classList.contains('is-note') && /Already rolling/.test(document.querySelector('#error-text').textContent)));

  // 15. A note/warning never moves the page (it floats)
  await update([], 9000);
  await update([], 9000);
  const topBefore = await ev(() => document.querySelector('.hero-bar').getBoundingClientRect().top);
  await ev(() => showNote('You already have “a.bin” — it’s in the burrow.', '/d/a.bin'));
  await p.waitForTimeout(400);
  const topAfter = await ev(() => document.querySelector('.hero-bar').getBoundingClientRect().top);
  check('showing a note does not move the page', Math.abs(topAfter - topBefore) < 1, `${topBefore} -> ${topAfter}`);
  await ev(() => hideError());
  await p.waitForTimeout(100);
  check('hiding it does not move the page either', Math.abs((await ev(() => document.querySelector('.hero-bar').getBoundingClientRect().top)) - topBefore) < 1);

  // 16. Speed limit: junk refused, plain numbers mean MB/s
  await ev(() => document.querySelector('#settings-btn').click());
  const setLimit = (v) => ev((val) => { const f = document.querySelector('#set-limit'); f.value = val; f.dispatchEvent(new Event('input')); f.dispatchEvent(new Event('change')); }, v);
  const settingsCalls = () => ev(() => window.__calls.filter((c) => c[0] === 'settings').length);
  const n0 = await settingsCalls();
  await setLimit('fast please');
  await p.waitForTimeout(50);
  check('junk speed limit is refused inline', await ev(() => document.querySelector('#set-limit').classList.contains('invalid') && !document.querySelector('#limit-error').hidden));
  check('...and not saved', (await settingsCalls()) === n0);
  await setLimit('5');
  await p.waitForTimeout(50);
  check('"5" saves as 5 MB/s', (await ev(() => JSON.stringify(window.__calls.filter((c) => c[0] === 'settings').at(-1)[1]))) === '{"globalLimit":"5M"}');
  check('...and reads back as "5 MB/s"', (await ev(() => document.querySelector('#set-limit').value)) === '5 MB/s');
  await setLimit('');
  await p.waitForTimeout(50);
  check('empty means no limit', (await ev(() => JSON.stringify(window.__calls.filter((c) => c[0] === 'settings').at(-1)[1]))) === '{"globalLimit":"0"}');
  await ev(() => document.querySelector('#settings-done').click());

  // 17. The wardrobe door: click, drag with snap, keyboard, focus safety
  const doorOpen = () => ev(() => document.querySelector('.app').classList.contains('door-open'));
  await ev(() => document.querySelector('#door-handle').click());
  check('clicking the handle slides History open', await doorOpen());
  check('Home is not tabbable behind the open door', await ev(() => document.querySelector('#main-view').inert));
  await ev(() => document.querySelector('#door-handle').click());
  check('clicking again slides it shut', !(await doorOpen()));
  check('History is not tabbable while shut', await ev(() => document.querySelector('#door-body').inert));
  check('handle stays clickable while shut', await ev(() => !document.querySelector('#door-handle').closest('[inert]')));
  const hb = await (await p.$('#door-handle')).boundingBox();
  await p.mouse.move(hb.x + 15, hb.y + 50); await p.mouse.down();
  await p.mouse.move(hb.x - 200, hb.y + 50, { steps: 6 });
  check('door follows the drag', Number(await ev(() => getComputedStyle(document.querySelector('#history-view')).getPropertyValue('--door-open'))) > 0.1);
  await p.mouse.move(hb.x - 120, hb.y + 50, { steps: 4 });
  await p.mouse.up();
  await p.waitForTimeout(600); // let the door settle before grabbing it again
  check('a short drag snaps back shut', !(await doorOpen()));
  await p.mouse.move(hb.x + 15, hb.y + 50); await p.mouse.down();
  await p.mouse.move(hb.x - 600, hb.y + 50, { steps: 10 }); await p.mouse.up();
  await p.waitForTimeout(100);
  check('a long drag snaps open', await doorOpen());
  await p.keyboard.press('Escape');
  check('Escape slides it shut', !(await doorOpen()));
  await p.keyboard.press('Control+]');
  check('Ctrl/Cmd+] opens, Ctrl/Cmd+[ closes', (await doorOpen()) && (await p.keyboard.press('Control+['), !(await doorOpen())));

  // 18. Hovering the handle must not move it (it used to jitter in and out of hover)
  await p.waitForTimeout(600); // let the door finish sliding shut first
  const hh = await p.$('#door-handle');
  const hb0 = await hh.boundingBox();
  await p.mouse.move(hb0.x + hb0.width - 3, hb0.y + hb0.height / 2);
  const xs = [];
  for (let i = 0; i < 8; i++) { await p.waitForTimeout(70); xs.push(Math.round((await hh.boundingBox()).x)); }
  check('handle holds still under the cursor', new Set(xs).size === 1 && (await ev(() => document.querySelector('#door-handle').matches(':hover'))), xs.join(','));
  await p.mouse.move(450, 100);

  // 11. Escape closes unsupported modal
  await ev(() => showUnsupported());
  await p.keyboard.press('Escape');
  check('Escape closes Not supported', await ev(() => document.querySelector('#modal').hidden));

  await b.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})();
