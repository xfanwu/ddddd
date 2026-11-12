'use strict';

const $ = (selector) => document.querySelector(selector);

const state = {
  items: [],
  history: [],
  global: { downloadSpeed: 0, numActive: 0, numWaiting: 0 },
  settings: {
    dir: '',
    connections: 4,
    split: 4,
    globalLimit: '0',
    verifyDmg: true,
    aria2Path: '',
  },
  engine: { running: false },
  verification: new Map(),
  ui: { historyOpen: false },
};

/* ---------- formatting ---------- */

function bytes(value = 0) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = index === 0 || size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[index]}`;
}

function eta(remaining, speed) {
  if (!speed || speed <= 0 || remaining <= 0) return '--';
  const seconds = Math.round(remaining / speed);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- rows ---------- */

/* Dung language: status words speak beetle. Buttons stay plain (Open, Pause,
   Cancel) so nobody has to guess what a click does. Keep every status string
   here so the voice stays consistent — see docs/DESIGN.md → Voice. */
const WORDS = {
  starting: 'waking up…',
  ready: 'ready to roll',
  setup: 'needs setup',
  down: 'napping',
  sniffing: 'sniffing it out…',
  sniffingSlow: 'still sniffing — this one’s shy…',
  rolling: 'rolling',
  inLine: 'in line',
  inLineLong: 'waiting its turn',
  resting: 'resting',
  home: 'rolled home',
  dropped: 'dropped',
  saved: 'in the burrow',
  idle: 'all quiet',
  emptyHistory: 'Nothing rolled in yet.',
};

const STATUS_LABEL = {
  probing: 'sniffing',
  active: WORDS.rolling,
  waiting: WORDS.inLine,
  paused: WORDS.resting,
  complete: WORDS.home,
  error: WORDS.dropped,
  removed: 'removed',
};

function liveRow(item) {
  const percent = item.totalLength
    ? Math.min(100, (item.completedLength / item.totalLength) * 100)
    : 0;

  const status = item.status === 'active' ? 'active' : item.status;
  const label = STATUS_LABEL[status] || status;

  const parts = [];
  if (status === 'probing') {
    parts.push(item.slow ? WORDS.sniffingSlow : WORDS.sniffing);
  } else if (status === 'active') {
    parts.push(`${bytes(item.downloadSpeed)}/s`);
    parts.push(`${bytes(item.completedLength)} of ${bytes(item.totalLength)}`);
    parts.push(`ETA ${eta(item.totalLength - item.completedLength, item.downloadSpeed)}`);
  } else if (status === 'waiting') {
    parts.push(WORDS.inLineLong);
    if (item.totalLength) parts.push(bytes(item.totalLength));
  } else if (status === 'paused') {
    parts.push(`${Math.round(percent)}% of ${bytes(item.totalLength)}`);
  } else if (status === 'complete') {
    parts.push(bytes(item.totalLength));
  } else {
    parts.push(shortError(item.errorMessage) || `error code ${item.errorCode}`);
  }

  const buttons = [];
  if ((status === 'active' || status === 'waiting') && item.extractor !== 'yt-dlp') {
    buttons.push(`<button class="mini" data-action="pause" data-gid="${item.gid}">Pause</button>`);
  }
  if (status === 'paused') {
    buttons.push(`<button class="mini" data-action="resume" data-gid="${item.gid}">Resume</button>`);
  }
  if (status === 'complete' || status === 'error') {
    if (item.path && status === 'complete') {
      buttons.push(`<button class="mini strong" data-action="open" data-path="${escapeHtml(item.path)}">Open</button>`);
    }
    if (item.path) {
      buttons.push(`<button class="mini" data-action="reveal" data-path="${escapeHtml(item.path)}">Show in folder</button>`);
    }
    buttons.push(`<button class="mini danger" data-action="remove" data-gid="${item.gid}">Remove</button>`);
  } else {
    buttons.push(`<button class="mini danger" data-action="remove" data-gid="${item.gid}">Cancel</button>`);
  }

  const check = state.verification.get(item.gid);
  let badge = `<span class="badge">${label}</span>`;
  if (item.extractor === 'yt-dlp') {
    badge += '<span class="badge accent">video</span>';
  } else if (status === 'active') {
    if (item.split) {
      badge += `<span class="badge accent">split ${item.split}</span>`;
    }
    badge += `<span class="badge">threads ${item.connections}</span>`;
  }
  if (check) {
    badge += check.ok
      ? '<span class="badge ok">checksum ok</span>'
      : `<span class="badge bad">${escapeHtml(check.detail)}</span>`;
  }

  return `
    <div class="item" data-status="${status}">
      <div class="item-top">
        <span class="name" title="${escapeHtml(item.path || item.name)}">${escapeHtml(item.name)}</span>
        <span class="meta">${escapeHtml(parts.join(' · '))}</span>
      </div>
      ${status === 'complete' ? '' : `<div class="bar"><i style="width:${percent.toFixed(1)}%"></i></div>`}
      <div class="item-bottom">
        ${badge}
        <span class="spacer"></span>
        ${buttons.join('')}
      </div>
    </div>`;
}

function historyRow(entry) {
  const when = new Date(entry.finishedAt).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return `
    <div class="item" data-status="complete">
      <div class="item-top">
        <span class="name" title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span>
        <span class="meta">${bytes(entry.size)} · ${escapeHtml(when)}</span>
      </div>
      <div class="item-bottom">
        <span class="badge">${WORDS.saved}</span>
        <span class="spacer"></span>
        <button class="mini strong" data-action="open" data-path="${escapeHtml(entry.path)}">Open</button>
        <button class="mini" data-action="reveal" data-path="${escapeHtml(entry.path)}">Show in folder</button>
        <button class="mini quiet" data-action="forget" data-id="${entry.id}" title="Remove from history">✕</button>
      </div>
    </div>`;
}

/* ---------- render ---------- */

/* ---------- what's happening right now ----------
   aria2 lists active, then waiting, then *oldest-first* stopped downloads, and
   video jobs come last, so list order says nothing about what just finished.
   Instead, watch each gid's status change and remember when it finished. Items
   already finished when Dung opened (restored session) count as old news. */

const RUNNING = ['probing', 'active', 'waiting', 'paused'];
const DONE = ['complete', 'error'];
const MAX_LANES = 3;
const LANE_LINGER = 8000; // a finished lane stays this long, then folds away

const tracker = {
  primed: false,
  status: new Map(), // gid -> last seen status
  finishedAt: new Map(), // gid -> when we saw it finish (fresh finishes only)
  added: new Map(), // gid -> first time we saw it
};

function trackItems(items) {
  const now = Date.now();
  const live = new Set();
  for (const item of items) {
    live.add(item.gid);
    const before = tracker.status.get(item.gid);
    if (!tracker.added.has(item.gid)) tracker.added.set(item.gid, now);
    if (DONE.includes(item.status) && !DONE.includes(before) && !tracker.finishedAt.has(item.gid)) {
      // Fresh finish: it was running, or it is new since launch and finished
      // between two polls (small files). Restored results are not fresh.
      if (tracker.primed) tracker.finishedAt.set(item.gid, now);
    }
    tracker.status.set(item.gid, item.status);
  }
  for (const gid of [...tracker.status.keys()]) {
    if (!live.has(gid)) {
      tracker.status.delete(gid);
      tracker.finishedAt.delete(gid);
      tracker.added.delete(gid);
    }
  }
  tracker.primed = true;
}

function runningItems() {
  // Newest first, so the big beetle follows what you just pasted.
  return state.items
    .filter((item) => RUNNING.includes(item.status))
    .sort((a, b) => (tracker.added.get(b.gid) || 0) - (tracker.added.get(a.gid) || 0));
}

function lastFinished() {
  let best = null;
  for (const item of state.items) {
    const at = tracker.finishedAt.get(item.gid);
    if (at && (!best || at > tracker.finishedAt.get(best.gid))) best = item;
  }
  return best;
}

// One download on Home: the newest running one, else the one that just
// finished — which stays (with Open) until you press Done or start another.
function currentItem() {
  const running = runningItems();
  // Prefer something actually moving over a queued/paused one.
  return running.find((item) => item.status === 'active' || item.status === 'probing') || running[0] || lastFinished();
}

function laneItems() {
  const now = Date.now();
  const fresh = state.items.filter((item) => {
    const at = tracker.finishedAt.get(item.gid);
    return at && now - at < LANE_LINGER;
  });
  return [...runningItems(), ...fresh];
}

function laneMeta(item) {
  if (item.status === 'waiting') return WORDS.inLine;
  if (item.status === 'probing') return WORDS.sniffing;
  if (item.status === 'paused') return WORDS.resting;
  if (item.status === 'complete') return WORDS.home;
  if (item.status === 'error') return shortError(item.errorMessage) || WORDS.dropped;
  const pct = item.totalLength ? Math.floor((item.completedLength / item.totalLength) * 100) : 0;
  return item.downloadSpeed ? `${pct}%  ·  ${bytes(item.downloadSpeed)}/s` : `${pct}%`;
}

function laneActions(item) {
  const gid = item.gid;
  const path = escapeHtml(item.path || '');
  if (item.status === 'complete' && item.path) {
    return `<button class="mini strong" data-action="open" data-path="${path}">Open</button>` +
      `<button class="mini quiet" data-action="remove" data-gid="${gid}" title="Dismiss">✕</button>`;
  }
  if (item.status === 'paused') {
    return `<button class="mini" data-action="resume" data-gid="${gid}">Resume</button>` +
      `<button class="mini quiet" data-action="remove" data-gid="${gid}" title="Cancel">✕</button>`;
  }
  const title = item.status === 'error' || item.status === 'complete' ? 'Dismiss' : 'Cancel';
  return `<button class="mini quiet" data-action="remove" data-gid="${gid}" title="${title}">✕</button>`;
}

function renderLanes(items) {
  const host = $('#lanes');
  const shown = items.slice(0, MAX_LANES);
  const keep = new Set(shown.map((item) => item.gid));

  for (const lane of [...host.children]) {
    if (!keep.has(lane.dataset.gid)) lane.remove();
  }

  shown.forEach((item, index) => {
    let lane = host.querySelector(`.lane[data-gid="${CSS.escape(item.gid)}"]`);
    if (!lane) {
      lane = document.createElement('div');
      lane.className = 'lane';
      lane.dataset.gid = item.gid;
      lane.innerHTML =
        '<div class="lane-head"><span class="lane-name"></span><span class="lane-meta"></span>' +
        '<span class="lane-actions"></span></div>' +
        '<dung-progress scale="2" no-label></dung-progress>';
      lane.isNew = true;
    }
    if (host.children[index] !== lane) host.insertBefore(lane, host.children[index] || null);

    lane.dataset.status = item.status;
    const name = lane.querySelector('.lane-name');
    name.textContent = item.name;
    name.title = item.path || item.name;
    lane.querySelector('.lane-meta').textContent = laneMeta(item);
    const actions = laneActions(item);
    const slot = lane.querySelector('.lane-actions');
    if (slot.dataset.html !== actions) {
      slot.innerHTML = actions;
      slot.dataset.html = actions;
    }

    const bar = lane.querySelector('dung-progress');
    if (item.status === 'probing') {
      bar.setAttribute('indeterminate', '');
    } else {
      bar.removeAttribute('indeterminate');
      const done = item.status === 'complete';
      bar.value = done ? 100 : item.totalLength ? Math.round((item.completedLength / item.totalLength) * 100) : 0;
    }
    // A lane that appears mid-download starts where the download already is.
    if (lane.isNew && lane.isConnected && typeof bar.jump === 'function') {
      lane.isNew = false;
      if (item.status !== 'probing') bar.jump(bar.value);
    }
    bar.setAttribute('aria-label', `${item.name} progress`);
  });

  return items.length - shown.length;
}

function stageMeta(item) {
  if (item.status === 'probing') {
    return item.slow ? WORDS.sniffingSlow : WORDS.sniffing;
  }
  if (item.status === 'complete') return bytes(item.totalLength);
  if (item.status === 'error') return shortError(item.errorMessage) || WORDS.dropped;
  if (item.status === 'paused') return WORDS.resting;

  const parts = [`${bytes(item.completedLength)} / ${bytes(item.totalLength)}`];
  if (item.downloadSpeed) parts.push(`${bytes(item.downloadSpeed)}/s`);
  if (item.totalLength && item.downloadSpeed) {
    parts.push(`ETA ${eta(item.totalLength - item.completedLength, item.downloadSpeed)}`);
  }
  return parts.join(' · ');
}

/* ---------- progress ---------- */

const progressBar = $('#progress');

function setProgress(mode, progress = 0) {
  if (!progressBar) return;
  progressBar.dataset.state = mode;

  if (mode === 'probing') {
    progressBar.setAttribute('indeterminate', '');
    progressBar.removeAttribute('value');
    return;
  }

  progressBar.removeAttribute('indeterminate');
  progressBar.value = Math.round(Math.max(0, Math.min(1, progress)) * 100);

  if (mode === 'idle') progressBar.setAttribute('no-label', '');
  else progressBar.removeAttribute('no-label');
}

function updateStage() {
  const lanes = laneItems();
  const multi = lanes.length >= 2 && !state.ui.historyOpen;
  $('#lanes').hidden = !multi;

  if (multi) {
    const extra = renderLanes(lanes);
    const othersLink = $('#others-link');
    othersLink.hidden = extra <= 0;
    othersLink.textContent = `+${extra} more`;
    $('.app').dataset.mode = 'lanes';
    return;
  }
  // Keep lanes alive while History is open, so the beetles don't restart at 0.
  if (!state.ui.historyOpen) $('#lanes').innerHTML = '';

  const item = currentItem();
  const othersLink = $('#others-link');
  // Only downloads still on their way count; finished ones live in History.
  const others = runningItems().filter((other) => !item || other.gid !== item.gid).length;
  othersLink.hidden = others <= 0;
  othersLink.textContent = `+${others} more`;

  $('.app').dataset.mode = state.ui.historyOpen ? 'history' : item ? 'active' : 'idle';

  // The big beetle follows one download at a time. When it switches to a
  // different one (or back to idle), snap instead of rolling backwards.
  const gid = item ? item.gid : '';
  if (progressBar.dataset.gid !== gid) {
    progressBar.dataset.gid = gid;
    const start = item && item.status === 'complete' ? 100 : item && item.totalLength ? Math.round((item.completedLength / item.totalLength) * 100) : 0;
    if (typeof progressBar.jump === 'function') progressBar.jump(start);
  }

  if (!item) {
    setProgress('idle', 0);
    $('#current-name').textContent = '';
    $('#current-meta').textContent = '';
    $('#current-badges').innerHTML = '';
    $('#stage-actions').innerHTML = '';
    return;
  }

  const mode =
    item.status === 'probing'
      ? 'probing'
      : item.status === 'complete'
        ? 'done'
        : item.status === 'error'
          ? 'error'
          : 'walking';

  const progress = item.status === 'complete' ? 1 : item.totalLength ? item.completedLength / item.totalLength : 0;
  setProgress(mode, progress);

  $('#current-name').textContent = item.name;
  $('#current-name').title = item.path || item.name;
  $('#current-meta').textContent = stageMeta(item);

  const label = STATUS_LABEL[item.status] || item.status;
  let badges = `<span class="badge">${label}</span>`;
  if (item.status === 'complete') {
    const check = state.verification.get(item.gid);
    if (check) {
      badges += check.ok
        ? '<span class="badge ok">checksum ok</span>'
        : `<span class="badge bad">${escapeHtml(check.detail)}</span>`;
    }
  }

  $('#current-badges').innerHTML = badges;
  $('#stage-actions').innerHTML = stageActions(item);
}

function stageActions(item) {
  const path = escapeHtml(item.path || '');
  const gid = item.gid;
  if (item.status === 'complete') {
    return (
      (item.path ? `<button class="primary" data-action="open" data-path="${path}">Open</button>` +
        `<button class="ghost" data-action="reveal" data-path="${path}">Show in folder</button>` : '') +
      `<button class="link-btn" data-action="remove" data-gid="${gid}">Done</button>`
    );
  }
  if (item.status === 'error') {
    return `<button class="ghost" data-action="remove" data-gid="${gid}">Dismiss</button>`;
  }
  const canPause = item.extractor !== 'yt-dlp' && ['active', 'waiting'].includes(item.status);
  return (
    (canPause ? `<button class="ghost" data-action="pause" data-gid="${gid}">Pause</button>` : '') +
    (item.status === 'paused' ? `<button class="primary" data-action="resume" data-gid="${gid}">Resume</button>` : '') +
    `<button class="link-btn" data-action="remove" data-gid="${gid}">Cancel</button>`
  );
}

/* ---------- state transitions ----------
   When the page changes shape (idle -> downloading -> lanes -> history), let the
   browser morph between the two layouts. Elements with a view-transition-name in
   styles.css (paste box, beetle, wordmark…) glide to their new spot. */

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function nextMode() {
  if (state.ui.historyOpen) return 'history';
  if (laneItems().length >= 2) return 'lanes';
  return currentItem() ? 'active' : 'idle';
}

let transitioning = false;
let renderQueued = false;

function render() {
  // Updates arrive several times a second. While a morph is playing, hold
  // them and render once at the end, instead of interrupting the animation.
  if (transitioning) {
    renderQueued = true;
    return;
  }
  const from = $('.app').dataset.mode;
  const to = nextMode();
  if (from && from !== to && document.startViewTransition && !reduceMotion.matches) {
    transitioning = true;
    document.documentElement.dataset.transition = `${from}-${to}`;
    const vt = document.startViewTransition(renderNow);
    vt.finished.finally(() => {
      delete document.documentElement.dataset.transition;
      transitioning = false;
      if (renderQueued) {
        renderQueued = false;
        render();
      }
    });
  } else {
    renderNow();
  }
}

function renderNow() {
  const livePaths = new Set(state.items.map((item) => item.path).filter(Boolean));
  const historyOnly = state.history.filter((entry) => !livePaths.has(entry.path));

  const rows = [...state.items.map(liveRow), ...historyOnly.map(historyRow)];
  $('#list').innerHTML = rows.join('');
  $('#empty').hidden = rows.length > 0;

  const liveSpeed = state.items.reduce(
    (sum, item) => sum + (item.status === 'active' ? item.downloadSpeed : 0),
    0
  );
  $('#global-speed').textContent = `${bytes(liveSpeed)}/s`;

  const threads = state.items.reduce(
    (sum, item) => sum + (item.status === 'active' ? item.connections : 0),
    0
  );
  $('#threads-count').textContent = `${threads} thread${threads === 1 ? '' : 's'}`;

  const active = state.items.filter((item) => item.status === 'active').length;
  const waiting = state.items.filter((item) => item.status === 'waiting').length;
  const summary = [];
  if (active) summary.push(`${active} ${WORDS.rolling}`);
  if (waiting) summary.push(`${waiting} ${WORDS.inLine}`);
  $('#active-count').textContent = summary.join(' · ') || WORDS.idle;

  $('#folder-label').textContent = state.settings.dir || '';
  $('#folder-label').title = state.settings.dir || '';

  $('#main-view').hidden = state.ui.historyOpen;
  $('#history-view').hidden = !state.ui.historyOpen;

  const homeBtn = $('#home-btn');
  const historyBtn = $('#history-btn');
  if (state.ui.historyOpen) {
    homeBtn.removeAttribute('aria-current');
    historyBtn.setAttribute('aria-current', 'page');
  } else {
    historyBtn.removeAttribute('aria-current');
    homeBtn.setAttribute('aria-current', 'page');
  }
  $('#history-count').textContent = state.history.length ? `(${state.history.length})` : '';

  updateStage();
}

// New users don't know what "aria2" or an "engine" is, so the home page only ever
// says "Dung needs one free helper" and offers a single Set up button. The raw
// error stays available under "What does this install?" and in the log.
function setEngine(status) {
  const dot = $('#status-dot');
  const label = $('#engine-label');
  const card = $('#setup-card');
  const error = String(status.error || '');

  label.title = status.ok && status.info && status.info.binary ? `aria2 · ${status.info.binary}` : error;
  $('#setup-raw').textContent = error ? `Details: ${error}` : '';

  if (status.ok) {
    dot.dataset.state = 'ready';
    label.textContent = WORDS.ready;
    card.hidden = true;
  } else if (/starting/i.test(error) || !error) {
    dot.dataset.state = 'starting';
    label.textContent = WORDS.starting;
    card.hidden = true;
  } else if (/not found|ENOENT/i.test(error)) {
    dot.dataset.state = 'error';
    label.textContent = WORDS.setup;
    showSetup('missing');
  } else {
    dot.dataset.state = 'error';
    label.textContent = WORDS.down;
    showSetup('broken');
  }

  engineOk = Boolean(status.ok);
  syncAddBtn();
  if (engineOk && pendingSubmit) {
    pendingSubmit = false;
    if ($('#url-input').value.trim()) submit();
  }
  $('.app').classList.toggle('needs-setup', !card.hidden);
}

// aria2 ships inside the app, so this card is a *recovery* screen: it only
// appears if the bundled downloader is missing (antivirus, a broken install)
// or keeps crashing. Windows can repair itself; macOS needs a reinstall.
const IS_MAC = window.api.platform === 'darwin';
const RELEASES_URL = 'https://github.com/xfanwu/ddddd/releases/latest';

const SETUP_COPY = {
  missing: IS_MAC
    ? ['Dung needs a quick fix', 'Part of Dung went missing. Download Dung again and replace the old copy — your downloads and settings stay.', 'Get Dung again']
    : ['Dung needs a quick fix', 'Part of Dung went missing, sometimes antivirus moves it. Dung can put it back.', 'Fix it'],
  installing: ['Fixing…', 'This usually takes a few seconds. Keep Dung open.', 'Fixing…'],
  reinstall: ['Dung needs a quick fix', 'Part of Dung went missing. Download Dung again and replace the old copy — your downloads and settings stay.', 'Get Dung again'],
  unsupported: ['Install the download helper', 'Install “aria2” with your system’s package manager, then reopen Dung.', 'Try again'],
  failed: ['That didn’t work', 'Check your internet connection and try again.', 'Try again'],
  broken: ['Dung’s downloader stopped', 'Try again. If it keeps happening, quit and reopen Dung.', 'Try again'],
};

function showSetup(kind) {
  const [title, text, button] = SETUP_COPY[kind] || SETUP_COPY.failed;
  $('#setup-card').hidden = false;
  $('#setup-card').dataset.kind = kind;
  $('#setup-title').textContent = title;
  $('#setup-text').textContent = text;
  $('#install-btn').textContent = button;
  $('#install-btn').disabled = kind === 'installing';
  $('#setup-card').dataset.action =
    kind === 'broken' ? 'restart' : kind === 'reinstall' || (kind === 'missing' && IS_MAC) ? 'reinstall' : 'repair';
  $('.app').classList.add('needs-setup');
}

/* ---------- actions ---------- */

$('#list').addEventListener('click', runAction);
$('#stage-actions').addEventListener('click', runAction);
$('#lanes').addEventListener('click', runAction);

async function runAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const { action, gid, path, id } = button.dataset;

  try {
    if (action === 'pause') await window.api.pause(gid);
    if (action === 'resume') await window.api.resume(gid);
    if (action === 'remove') {
      await window.api.remove(gid);
      state.verification.delete(gid);
    }
    if (action === 'reveal') await window.api.reveal(path);
    if (action === 'open') await window.api.open(path);
    if (action === 'forget') {
      state.history = await window.api.forgetHistory(id);
      render();
    }
  } catch (err) {
    showError(err.message);
  }
}

$('#add-btn').addEventListener('click', submit);

$('#url-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});

const LINK_RE = /^(https?:\/\/|ftp:\/\/|magnet:\?|thunder:\/\/)/i;
const hasLink = (text) => (text || '').split(/\s+/).some((part) => LINK_RE.test(part));

// Paste a link and it just goes: no extra click needed.
$('#url-input').addEventListener('paste', () => {
  setTimeout(() => {
    syncAddBtn();
    if (hasLink($('#url-input').value)) submit();
  }, 0);
});

$('#url-input').addEventListener('input', syncAddBtn);

let engineOk = false;
let pendingSubmit = false;

function syncAddBtn() {
  $('#add-btn').disabled = !engineOk || !$('#url-input').value.trim();
}

// ⌘V / Ctrl+V anywhere on the page works too, even if the box isn't focused.
document.addEventListener('paste', (event) => {
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  if (document.querySelector('.modal-scrim:not([hidden])')) return;
  const text = event.clipboardData && event.clipboardData.getData('text');
  if (!text) return;
  event.preventDefault();
  $('#url-input').value = text.trim();
  if (state.ui.historyOpen) showView('home');
  submit();
});

// Dropping a link onto the window downloads it.
const appEl = $('.app');
// dragenter/leave fire for every child element, so count them; dragleave's
// relatedTarget is unreliable in Chromium.
let dragDepth = 0;
const endDrag = () => {
  dragDepth = 0;
  appEl.classList.remove('dragging');
};
appEl.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth += 1;
  appEl.classList.add('dragging');
});
appEl.addEventListener('dragover', (event) => event.preventDefault());
appEl.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) appEl.classList.remove('dragging');
});
window.addEventListener('blur', endDrag);
appEl.addEventListener('drop', (event) => {
  event.preventDefault();
  endDrag();
  if (state.ui.historyOpen) showView('home');
  const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text');
  if (!text) return;
  $('#url-input').value = text.trim();
  submit();
});

function nudgeBar() {
  const bar = $('.hero-bar');
  bar.classList.remove('flash');
  void bar.offsetWidth;
  bar.classList.add('flash');
}

async function submit() {
  const input = $('#url-input');
  const raw = input.value.trim();
  if (!raw) return;

  const urls = raw.split(/\s+/).filter((url) => /^(https?:\/\/|ftp:\/\/|magnet:\?|thunder:\/\/)/i.test(url));
  if (!urls.length) {
    nudgeBar();
    showError('That doesn’t look like a link. Copy a link that starts with https:// and paste it here.');
    return;
  }

  // Pasted while Dung is still waking up: keep the link and send it the
  // moment the downloader is ready, instead of failing.
  if (!engineOk) {
    pendingSubmit = true;
    hideError();
    return;
  }

  input.value = '';
  syncAddBtn();
  hideError();

  try {
    const result = await window.api.add(urls, {});
    if (result && Array.isArray(result.conflicts)) {
      result.conflicts.forEach(queueConflict);
    }
    if (result && result.skipped && result.skipped.length) {
      showUnsupported();
    }
  } catch (err) {
    showError(err.message);
    input.value = raw;
    syncAddBtn();
  }
}

let errorTimer = null;
let errorRevealPath = '';

// aria2 refuses to touch an existing file when its control file is gone. The
// raw message names the path, but it reads like a crash and is long enough to
// overflow the banner, so translate it into something actionable.
const FILE_EXISTS = /File (.+?) exists, but a control file\s*\(\*\.aria2\) does not exist/i;

function shortError(message) {
  const match = String(message || '').match(FILE_EXISTS);
  if (!match) return message || '';
  const name = match[1].split(/[\\/]/).pop() || match[1];
  return `"${name}" already exists - delete or move it, then retry`;
}

function describeError(message) {
  const text = String(message || '');
  const match = text.match(FILE_EXISTS);
  if (!match) return { text, reveal: '' };

  const target = match[1];
  const name = target.split(/[\\/]/).pop() || target;
  return {
    text: `"${name}" already exists, so Dung stopped instead of overwriting it. Delete or move the file, then try again.`,
    reveal: target,
  };
}

function showError(message) {
  const banner = $('#error-banner');
  const described = describeError(message);
  errorRevealPath = described.reveal;
  $('#error-text').textContent = described.text;
  $('#error-text').title = described.reveal;
  $('#error-reveal').hidden = !errorRevealPath;
  banner.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(hideError, 8000);

  const needsYtdlp = /yt-dlp not found/i.test(message);
  if (needsYtdlp) {
    $('#error-text').textContent = 'This link is a video page. Add free video support to save it.';
  }
  $('#install-ytdlp').hidden = !needsYtdlp;
}

$('#error-reveal').addEventListener('click', () => {
  if (errorRevealPath) window.api.reveal(errorRevealPath);
});

$('#install-ytdlp').addEventListener('click', async () => {
  const button = $('#install-ytdlp');
  button.disabled = true;
  button.textContent = 'Installing…';
  try {
    const result = await window.api.installExtractor();
    if (result.ok) {
      $('#error-banner').hidden = true;
      state.settings.ytdlpPath = result.binary;
    } else {
      $('#error-text').textContent = result.error;
    }
  } catch (err) {
    $('#error-text').textContent = err.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Add video support';
    button.hidden = true;
  }
});

function hideError() {
  $('#error-banner').hidden = true;
  errorRevealPath = '';
  $('#error-reveal').hidden = true;
}

$('#clear-btn').addEventListener('click', async () => {
  try {
    await window.api.clearFinished();
    state.history = [];
    render();
  } catch (err) {
    showError(err.message);
  }
});

/* ---------- settings ---------- */

const settingsModal = $('#settings-modal');

function openSettings() {
  if (!settingsModal.hidden) return;
  fillSettingsForm();
  settingsModal.hidden = false;
  $('.settings-modal').focus();
}

function fillSettingsForm() {
  const dir = state.settings.dir || '';
  $('#set-dir').value = dir;
  $('#set-dir-name').textContent = dir.split(/[\\/]/).filter(Boolean).pop() || 'Choose a folder';
  $('#set-conn').value = state.settings.connections;
  $('#set-split').value = state.settings.split;
  const limit = state.settings.globalLimit;
  $('#set-limit').value = !limit || limit === '0' ? '' : limit;
  $('#set-verify').checked = Boolean(state.settings.verifyDmg);
  $('#set-binary').value = state.settings.aria2Path || '';
  $('#set-ytdlp').value = state.settings.ytdlpPath || '';
  updateConnHint();
}

function closeSettings() {
  if (settingsModal.hidden) return;
  settingsModal.hidden = true;
  $('#settings-btn').focus();
}

function updateConnHint() {
  const value = Number($('#set-conn').value);
  const hint = $('#conn-hint');
  if (value <= 4) hint.textContent = `${value} · safe`;
  else if (value <= 8) hint.textContent = `${value} · mostly safe`;
  else hint.textContent = `${value} · corrupts files`;
  hint.style.color = value > 8 ? 'var(--danger)' : 'var(--accent-strong)';

  const split = Number($('#set-split').value);
  $('#split-hint').textContent = String(split);
}

$('#settings-btn').addEventListener('click', openSettings);
$('#settings-done').addEventListener('click', closeSettings);
$('#close-settings').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (event) => {
  if (event.target === settingsModal) closeSettings();
});



/* ---------- download conflict ---------- */

const conflictModal = $('#conflict-modal');
const conflictQueue = [];
let activeConflict = null;

function showNextConflict() {
  if (activeConflict || !conflictQueue.length) return;

  activeConflict = conflictQueue.shift();
  $('#conflict-name').textContent = activeConflict.name;
  $('#conflict-name').title = activeConflict.path || activeConflict.name;
  conflictModal.hidden = false;
  $('#conflict-cancel').focus();
}

function queueConflict(info) {
  if (!info || (!info.id && !info.gid)) return;
  info.id = info.id || info.gid;
  conflictQueue.push(info);
  showNextConflict();
}

async function resolveConflict(action) {
  if (!activeConflict) return;

  const conflict = activeConflict;
  activeConflict = null;
  conflictModal.hidden = true;

  try {
    await window.api.resolveConflict(conflict.id, action);
  } catch (err) {
    showError(err.message);
  }

  showNextConflict();
}

$('#conflict-cancel').addEventListener('click', () => resolveConflict('cancel'));
$('#conflict-keep').addEventListener('click', () => resolveConflict('keep-both'));
$('#conflict-overwrite').addEventListener('click', () => resolveConflict('overwrite'));
conflictModal.addEventListener('click', (event) => {
  if (event.target === conflictModal) resolveConflict('cancel');
});

/* ---------- unsupported site modal ---------- */

function showUnsupported() {
  $('#modal-text').textContent =
    "YouTube downloading is not supported due to restrictions from YouTube's side.";
  $('#modal').hidden = false;
  $('#modal-ok').focus();
}

function hideModal() {
  $('#modal').hidden = true;
}

$('#modal-ok').addEventListener('click', hideModal);
$('#modal').addEventListener('click', (event) => {
  if (event.target.id === 'modal') hideModal();
});

/* ---------- updates ---------- */

let updatePhase = 'idle';

function applyUpdateStatus(payload) {
  if (!payload) return;

  const note = $('#update-note');
  const banner = $('#update-banner');
  const downloadBtn = $('#update-download');

  if (payload.status === 'checking') {
    // A background re-check must never overwrite an in-flight download.
    if (updatePhase === 'idle') note.textContent = 'Checking for updates…';
    return;
  }

  if (payload.status === 'error') {
    note.textContent = `Update check failed: ${payload.error}`;
    return;
  }

  if (payload.status !== 'done') return;

  if (payload.updateAvailable) {
    banner.hidden = false;
    $('#update-text').textContent = `Version ${payload.latestVersion} is available`;

    if (updatePhase === 'idle') {
      note.textContent = `Update available: ${payload.latestVersion}`;
      downloadBtn.hidden = false;
      downloadBtn.textContent = 'Download';
      downloadBtn.disabled = false;
    }
  } else {
    banner.hidden = true;
    if (updatePhase === 'idle') {
      note.textContent = payload.manual
        ? `You are on the latest version (${payload.currentVersion}).`
        : '';
    }
  }
}

function applyUpdateProgress(progress) {
  const downloadBtn = $('#update-download');
  if (!progress || updatePhase !== 'downloading') return;

  if (progress.done) {
    updatePhase = 'ready';
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Open installer';
    $('#update-note').textContent = `Saved to ${progress.path}`;
    return;
  }

  downloadBtn.textContent = `Downloading ${Math.round(progress.percent || 0)}%`;
}

$('#check-updates').addEventListener('click', async () => {
  const button = $('#check-updates');
  button.disabled = true;
  $('#update-note').textContent = 'Checking for updates…';
  try {
    applyUpdateStatus(await window.api.checkUpdates());
  } catch (err) {
    $('#update-note').textContent = `Update check failed: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

$('#update-download').addEventListener('click', async () => {
  const button = $('#update-download');

  if (updatePhase === 'ready') {
    await window.api.openUpdate();
    return;
  }

  if (updatePhase === 'downloading') return;

  updatePhase = 'downloading';
  button.disabled = true;
  button.textContent = 'Downloading…';

  try {
    const result = await window.api.downloadUpdate();
    if (!result.ok) {
      updatePhase = 'idle';
      button.disabled = false;
      button.textContent = 'Download';
      $('#update-note').textContent = result.error;
    }
  } catch (err) {
    updatePhase = 'idle';
    button.disabled = false;
    button.textContent = 'Download';
    $('#update-note').textContent = err.message;
  }
});

$('#update-later').addEventListener('click', () => {
  $('#update-banner').hidden = true;
});

/* ---------- engine install ---------- */

$('#install-btn').addEventListener('click', async () => {
  const action = $('#setup-card').dataset.action;
  if (action === 'reinstall') {
    window.api.openExternal(RELEASES_URL);
    return;
  }
  if (action === 'restart') {
    // A crash is not a missing file: just start the downloader again.
    showSetup('installing');
    $('#setup-title').textContent = 'Waking Dung up…';
    $('#setup-text').textContent = 'Starting the downloader again.';
    try {
      const result = await window.api.restartEngine();
      if (!result.ok) showSetup('broken');
    } catch (err) {
      $('#setup-raw').textContent = `Details: ${err.message}`;
      showSetup('broken');
    }
    return;
  }
  showSetup('installing');
  try {
    const result = await window.api.installEngine();
    if (result.ok) {
      $('#setup-card').hidden = true;
      $('.app').classList.remove('needs-setup');
    } else {
      $('#setup-raw').textContent = result.error ? `Details: ${result.error}` : '';
      showSetup(['reinstall', 'unsupported'].includes(result.reason) ? result.reason : 'failed');
    }
  } catch (err) {
    $('#setup-raw').textContent = `Details: ${err.message}`;
    showSetup('failed');
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !conflictModal.hidden) {
    event.preventDefault();
    resolveConflict('cancel');
    return;
  }

  if (!conflictModal.hidden) return;

  if (event.key === 'Escape' && !$('#modal').hidden) {
    hideModal();
    return;
  }

  if (event.key === 'Escape' && !settingsModal.hidden) {
    closeSettings();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    openSettings();
  }
});

$('#set-conn').addEventListener('input', updateConnHint);
$('#set-split').addEventListener('input', updateConnHint);

$('#browse-btn').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (dir) {
    state.settings.dir = dir;
    await save({ dir });
    fillSettingsForm();
    render();
  }
});

async function save(patch) {
  try {
    state.settings = await window.api.updateSettings(patch);
    render();
  } catch (err) {
    showError(err.message);
  }
}

$('#set-conn').addEventListener('change', (event) => save({ connections: Number(event.target.value) }));
$('#set-split').addEventListener('change', (event) => save({ split: Number(event.target.value) }));
$('#set-limit').addEventListener('change', (event) => save({ globalLimit: event.target.value.trim() || '0' }));
$('#set-verify').addEventListener('change', (event) => save({ verifyDmg: event.target.checked }));
$('#set-binary').addEventListener('change', (event) => save({ aria2Path: event.target.value.trim() }));
$('#set-ytdlp').addEventListener('change', (event) => save({ ytdlpPath: event.target.value.trim() }));


/* ---------- engine wiring ---------- */

window.api.onUpdate((payload) => {
  state.items = payload.items || [];
  trackItems(state.items);
  state.history = payload.history || [];
  state.global = payload.global || state.global;
  render();
});

window.api.onStatus((status) => {
  state.engine = status.info || state.engine;
  setEngine(status);
});

window.api.onUpdateStatus(applyUpdateStatus);
window.api.onUpdateProgress(applyUpdateProgress);

window.api.onOpenSettings(openSettings);
window.api.onView(showView);
window.api.onConflict(queueConflict);

window.api.onVerify((result) => {
  state.verification.set(result.gid, { ok: result.ok, detail: result.detail });
  render();
});

const logNode = $('#log');
window.api.onLog((line) => {
  logNode.textContent += `${line}\n`;
  if (logNode.textContent.length > 8000) {
    logNode.textContent = logNode.textContent.slice(-6000);
  }
});

function showView(view) {
  state.ui.historyOpen = view === 'history';
  render();
}

$('#home-btn').addEventListener('click', () => showView('home'));
$('#history-btn').addEventListener('click', () => showView('history'));

$('#others-link').addEventListener('click', () => showView('history'));

/* ---------- boot ---------- */

(async function boot() {
  document.body.dataset.platform = window.api.platform || 'unknown';
  if (window.api.platform !== 'darwin') $('#paste-key').textContent = 'Ctrl V';
  if (window.api.platform !== 'darwin') {
    $('#verify-field').hidden = true;
  }

  try {
    const snapshot = await window.api.getState();
    $('#app-version').textContent = snapshot.version || '';
    if (snapshot.update) applyUpdateStatus(snapshot.update);
    state.settings = snapshot.settings;
    state.history = snapshot.history || [];
    state.engine = snapshot.engine || state.engine;
    if (snapshot.status) setEngine(snapshot.status);
    fillSettingsForm();
    render();
  } catch (err) {
    showError(err.message);
  }
})();
