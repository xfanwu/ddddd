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
  if (status === 'active') {
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
    parts.push(item.errorMessage || `error code ${item.errorCode}`);
  }

  const buttons = [];
  if (status === 'active' || status === 'waiting') {
    buttons.push(`<button class="mini" data-action="pause" data-gid="${item.gid}">Pause</button>`);
  }
  if (status === 'paused') {
    buttons.push(`<button class="mini" data-action="resume" data-gid="${item.gid}">Resume</button>`);
  }
  if (status === 'complete' || status === 'error') {
    if (item.path) {
      buttons.push(`<button class="mini" data-action="reveal" data-path="${escapeHtml(item.path)}">Reveal</button>`);
    }
    buttons.push(`<button class="mini danger" data-action="remove" data-gid="${item.gid}">Remove</button>`);
  } else {
    buttons.push(`<button class="mini danger" data-action="remove" data-gid="${item.gid}">Cancel</button>`);
  }

  const check = state.verification.get(item.gid);
  let badge = `<span class="badge">${label}</span>`;
  if (item.split) {
    badge += `<span class="badge accent">split ${item.split}</span>`;
  }
  badge += `<span class="badge">threads ${item.connections}</span>`;
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
      <div class="bar"><i style="width:${percent.toFixed(1)}%"></i></div>
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
      <div class="bar"><i style="width:100%"></i></div>
      <div class="item-bottom">
        <span class="badge">saved</span>
        <span class="spacer"></span>
        <button class="mini" data-action="reveal" data-path="${escapeHtml(entry.path)}">Reveal</button>
        <button class="mini danger" data-action="forget" data-id="${entry.id}">Forget</button>
      </div>
    </div>`;
}

/* ---------- render ---------- */

function render() {
  const livePaths = new Set(state.items.map((item) => item.path).filter(Boolean));
  const historyOnly = state.history.filter((entry) => !livePaths.has(entry.path));

  const rows = [
    ...state.items.map(liveRow),
    ...historyOnly.map(historyRow),
  ];

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
}

function setEngine(status) {
  const dot = $('#status-dot');
  const label = $('#engine-label');
  const banner = $('#error-banner');
  const message = $('#error-text');
  const installBtn = $('#install-btn');

  if (status.ok) {
    dot.dataset.state = 'ready';
    label.textContent = `aria2 ${status.info && status.info.binary ? status.info.binary : 'ready'}`;
    banner.hidden = true;
    installBtn.hidden = true;
  } else {
    const error = status.error || 'Download engine is not running';
    dot.dataset.state = 'error';
    label.textContent = 'engine offline';
    message.textContent = error;
    banner.hidden = false;

    // Offer the one-click install only when the binary is genuinely missing.
    installBtn.hidden = !/not found|ENOENT/i.test(error);
    installBtn.disabled = false;
    installBtn.textContent = 'Download aria2';
  }

  const addButton = $('#add-btn');
  addButton.disabled = !status.ok;
}

/* ---------- actions ---------- */

$('#list').addEventListener('click', async (event) => {
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
    if (action === 'forget') {
      state.history = await window.api.forgetHistory(id);
      render();
    }
  } catch (err) {
    showError(err.message);
  }
});

$('#add-btn').addEventListener('click', submit);

$('#url-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});

$('#url-input').addEventListener('paste', () => {
  setTimeout(() => $('#add-btn').focus(), 0);
});

async function submit() {
  const input = $('#url-input');
  const raw = input.value.trim();
  if (!raw) return;

  const urls = raw.split(/\s+/).filter((url) => /^(https?:\/\/|ftp:\/\/|magnet:\?|thunder:\/\/)/i.test(url));
  if (!urls.length) {
    showError('That does not look like a download URL.');
    return;
  }

  input.value = '';
  hideError();

  try {
    await window.api.add(urls, {});
  } catch (err) {
    showError(err.message);
    input.value = raw;
  }
}

let errorTimer = null;

function showError(message) {
  const banner = $('#error-banner');
  banner.textContent = message;
  banner.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(hideError, 6000);
}

function hideError() {
  $('#error-banner').hidden = true;
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

const panel = $('#panel');
const scrim = $('#scrim');

function openPanel() {
  fillSettingsForm();
  panel.hidden = false;
  scrim.hidden = false;
}

function fillSettingsForm() {
  $('#set-dir').value = state.settings.dir || '';
  $('#set-conn').value = state.settings.connections;
  $('#set-split').value = state.settings.split;
  $('#set-limit').value = state.settings.globalLimit;
  $('#set-verify').checked = Boolean(state.settings.verifyDmg);
  $('#set-binary').value = state.settings.aria2Path || '';
  updateConnHint();
}

function closePanel() {
  panel.hidden = true;
  scrim.hidden = true;
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

$('#settings-btn').addEventListener('click', openPanel);
$('#close-panel').addEventListener('click', closePanel);
scrim.addEventListener('click', closePanel);

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
  if (event.key === 'Escape' && !panel.hidden) closePanel();
});

$('#set-conn').addEventListener('input', updateConnHint);
$('#set-split').addEventListener('input', updateConnHint);

$('#browse-btn').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (dir) {
    state.settings.dir = dir;
    $('#set-dir').value = dir;
    await save({ dir });
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

/* ---------- boot ---------- */

(async function boot() {
  document.body.dataset.platform = window.api.platform || 'unknown';
  if (window.api.platform !== 'darwin') {
    $('#verify-field').hidden = true;
  }

  try {
    const snapshot = await window.api.getState();
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
