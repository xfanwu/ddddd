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
  lastDoneGid: null,
  doneUntil: 0,
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

const STATUS_LABEL = {
  probing: 'detecting',
  active: 'downloading',
  waiting: 'queued',
  paused: 'paused',
  complete: 'complete',
  error: 'failed',
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
    parts.push(item.slow ? 'still detecting — this source is slow…' : 'identifying source…');
  } else if (status === 'active') {
    parts.push(`${bytes(item.downloadSpeed)}/s`);
    parts.push(`${bytes(item.completedLength)} of ${bytes(item.totalLength)}`);
    parts.push(`ETA ${eta(item.totalLength - item.completedLength, item.downloadSpeed)}`);
  } else if (status === 'waiting') {
    parts.push('waiting for a slot');
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
    badge += '<span class="badge accent">yt-dlp</span>';
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
        <span class="badge">saved</span>
        <span class="spacer"></span>
        <button class="mini strong" data-action="open" data-path="${escapeHtml(entry.path)}">Open</button>
        <button class="mini" data-action="reveal" data-path="${escapeHtml(entry.path)}">Show in folder</button>
        <button class="mini quiet" data-action="forget" data-id="${entry.id}" title="Remove from history">✕</button>
      </div>
    </div>`;
}

/* ---------- render ---------- */

function currentItem() {
  const items = state.items;
  const running = items.find((item) => ['probing', 'active', 'waiting', 'paused'].includes(item.status));
  if (running) return running;

  const latest = items[0];
  if (latest && (latest.status === 'complete' || latest.status === 'error')) {
    if (state.lastDoneGid !== latest.gid) {
      state.lastDoneGid = latest.gid;
      state.doneUntil = Date.now() + 6000;
    }
    if (Date.now() < state.doneUntil) return latest;
  }

  return null;
}

function stageMeta(item) {
  if (item.status === 'probing') {
    return item.slow ? 'still detecting — this source is slow…' : 'identifying source…';
  }
  if (item.status === 'complete') return `${bytes(item.totalLength)} · complete`;
  if (item.status === 'error') return shortError(item.errorMessage) || 'failed';
  if (item.status === 'paused') return 'paused';

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
  const item = currentItem();
  const others = state.items.length - (item ? 1 : 0);
  const othersLink = $('#others-link');

  if (others > 0) {
    othersLink.hidden = false;
    othersLink.textContent = `${others} more task${others === 1 ? '' : 's'}`;
  } else {
    othersLink.hidden = true;
  }

  $('.app').dataset.mode = state.ui.historyOpen ? 'history' : item ? 'active' : 'idle';

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

  const progress = item.totalLength ? item.completedLength / item.totalLength : 0;
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

function render() {
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
  if (active) summary.push(`${active} active`);
  if (waiting) summary.push(`${waiting} queued`);
  $('#active-count').textContent = summary.join(' · ') || 'idle';

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

function setEngine(status) {
  const dot = $('#status-dot');
  const label = $('#engine-label');
  const banner = $('#error-banner');
  const message = $('#error-text');
  const installBtn = $('#install-btn');

  if (status.ok) {
    dot.dataset.state = 'ready';
    label.textContent = 'ready';
    label.title = status.info && status.info.binary ? `aria2 · ${status.info.binary}` : '';
    banner.hidden = true;
    installBtn.hidden = true;
  } else {
    const error = status.error || 'Download engine is not running';
    dot.dataset.state = 'error';
    label.textContent = 'not ready';
    errorRevealPath = '';
    message.textContent = error;
    message.title = '';
    $('#error-reveal').hidden = true;
    banner.hidden = false;

    // Offer the one-click install only when the binary is genuinely missing.
    installBtn.hidden = !/not found|ENOENT/i.test(error);
    installBtn.disabled = false;
    installBtn.textContent = 'Download aria2';
  }

  engineOk = Boolean(status.ok);
  syncAddBtn();
}

/* ---------- actions ---------- */

$('#list').addEventListener('click', runAction);
$('#stage-actions').addEventListener('click', runAction);

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
appEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  appEl.classList.add('dragging');
});
appEl.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) appEl.classList.remove('dragging');
});
appEl.addEventListener('drop', (event) => {
  event.preventDefault();
  appEl.classList.remove('dragging');
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
  $('#install-ytdlp').hidden = !needsYtdlp;
  if (needsYtdlp) {
    $('#install-btn').hidden = true;
  }
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
    button.textContent = 'Install yt-dlp';
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
  const button = $('#install-btn');
  const brewButton = $('#brew-btn');

  button.disabled = true;
  button.textContent = 'Installing…';
  brewButton.hidden = true;

  try {
    const result = await window.api.installEngine();
    if (result.ok) {
      button.hidden = true;
      $('#error-banner').hidden = true;
    } else {
      $('#error-text').textContent = result.error;
      if (result.reason === 'no-brew') brewButton.hidden = false;
    }
  } catch (err) {
    $('#error-text').textContent = err.message;
  } finally {
    button.disabled = false;
    if (!button.hidden) button.textContent = 'Download aria2';
  }
});

$('#brew-btn').addEventListener('click', () => {
  window.api.openExternal('https://brew.sh');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !conflictModal.hidden) {
    event.preventDefault();
    resolveConflict('cancel');
    return;
  }

  if (!conflictModal.hidden) return;

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
