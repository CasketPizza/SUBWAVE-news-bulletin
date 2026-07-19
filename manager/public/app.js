const $ = (id) => document.getElementById(id);
let model = null;
let assets = {};
let noticeTimer = null;

function notice(message, error = false) {
  const box = $('notice');
  box.textContent = message;
  box.classList.remove('hidden', 'error');
  if (error) box.classList.add('error');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => box.classList.add('hidden'), 10000);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error || body || `${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  }[ch]));
}

function feedRow(feed = { name: '', url: '' }) {
  const row = document.createElement('div');
  row.className = 'feed-row';
  row.innerHTML = `
    <label>Source name<input class="feed-name" type="text" value="${escapeHtml(feed.name || '')}" placeholder="ABC News"></label>
    <label>RSS or Atom URL<input class="feed-url" type="url" value="${escapeHtml(feed.url || '')}" placeholder="https://example.com/rss.xml"></label>
    <button class="remove-feed" type="button">Remove</button>`;
  row.querySelector('.remove-feed').onclick = () => row.remove();
  $('feeds').appendChild(row);
}

function setValue(id, value) {
  const element = $(id);
  if (element.type === 'checkbox') element.checked = Boolean(value);
  else element.value = value ?? '';
}

async function load() {
  const payload = await api('/api/settings');
  model = payload.settings;
  assets = payload.assets;
  $('feeds').innerHTML = '';
  model.feeds.forEach(feedRow);
  [
    'enabled','customMinute','timeZone','maxItemsPerFeed','maxCandidates',
    'maxHeadlines','maxLengthSeconds','bedVolumeDb','bedFadeIn','bedFadeOut','loopBed',
  ].forEach((id) => setValue(id, model[id]));
  const selected = document.querySelector(`input[name=scheduleMode][value="${model.scheduleMode}"]`);
  if (selected) selected.checked = true;
  updateAssetStates();
  await Promise.all([loadStatus(), loadLogs()]);
}

function collect() {
  return {
    ...model,
    enabled: $('enabled').checked,
    scheduleMode: document.querySelector('input[name=scheduleMode]:checked')?.value || 'after',
    customMinute: Number($('customMinute').value),
    timeZone: $('timeZone').value,
    feeds: [...document.querySelectorAll('.feed-row')].map((row) => ({
      name: row.querySelector('.feed-name').value,
      url: row.querySelector('.feed-url').value,
    })),
    maxItemsPerFeed: Number($('maxItemsPerFeed').value),
    maxCandidates: Number($('maxCandidates').value),
    maxHeadlines: Number($('maxHeadlines').value),
    maxLengthSeconds: Number($('maxLengthSeconds').value),
    bedVolumeDb: Number($('bedVolumeDb').value),
    bedFadeIn: Number($('bedFadeIn').value),
    bedFadeOut: Number($('bedFadeOut').value),
    loopBed: $('loopBed').checked,
  };
}

function updateAssetStates() {
  for (const type of ['intro','bed','outro']) {
    $(`${type}State`).textContent = assets[type] ? 'Uploaded and ready' : 'No audio uploaded';
  }
}

async function save() {
  const payload = await api('/api/settings', {
    method: 'PUT',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(collect()),
  });
  model = payload.settings;
  notice('Settings saved.');
}

async function uploadAsset(type) {
  const input = $(`${type}File`);
  if (!input.files[0]) throw new Error('Choose an audio file first.');
  const form = new FormData();
  form.append('file', input.files[0]);
  await api(`/api/assets/${type}`, { method: 'POST', body: form });
  assets[type] = true;
  input.value = '';
  updateAssetStates();
  notice(`${type === 'bed' ? 'Background music' : `${type} jingle`} uploaded.`);
}

async function removeAsset(type) {
  await api(`/api/assets/${type}`, { method: 'DELETE' });
  assets[type] = false;
  updateAssetStates();
  $('preview').classList.add('hidden');
  notice('Audio removed.');
}

function previewAsset(type) {
  if (!assets[type]) return notice('No audio has been uploaded for that field.', true);
  const player = $('preview');
  player.src = `/api/assets/${type}?t=${Date.now()}`;
  player.classList.remove('hidden');
  player.play();
}

async function loadStatus() {
  const status = await api('/api/status');
  $('managerStatus').textContent = status.busy ? 'Preparing bulletin…' : 'Running';
  $('versionStatus').textContent = status.updateAvailable
    ? `${status.version} — update available`
    : status.version;
  $('subwaveStatus').textContent = status.subwave?.connected ? 'Connected' : `Error: ${status.subwave?.error || 'unreachable'}`;
  $('personaStatus').textContent = status.subwave?.persona || 'Unknown';
  $('llmStatus').textContent = status.subwave?.llm || 'Unknown';
  $('ttsStatus').textContent = status.subwave?.tts || 'Unknown';
  $('lastRun').textContent = status.lastRunAt
    ? `${new Date(status.lastRunAt).toLocaleString()} — ${status.lastRunStatus}`
    : 'Never';
  return status;
}

async function loadLogs() {
  $('logs').textContent = await api('/api/logs');
}

async function command(path, message) {
  const result = await api(path, { method: 'POST' });
  notice(result.message || message);
}

$('addFeed').onclick = () => feedRow();
$('save').onclick = () => save().catch((error) => notice(error.message, true));
$('runNow').onclick = async () => {
  $('runNow').disabled = true;
  notice('Preparing the bulletin. This can take a minute.');
  try {
    const result = await api('/api/run', { method: 'POST' });
    notice(`Bulletin queued: ${result.spoken}`);
    await load();
  } catch (error) {
    notice(error.message, true);
  } finally {
    $('runNow').disabled = false;
  }
};

document.querySelectorAll('[data-upload]').forEach((button) => {
  button.onclick = () => uploadAsset(button.dataset.upload).catch((error) => notice(error.message, true));
});
document.querySelectorAll('[data-remove]').forEach((button) => {
  button.onclick = () => removeAsset(button.dataset.remove).catch((error) => notice(error.message, true));
});
document.querySelectorAll('[data-preview]').forEach((button) => {
  button.onclick = () => previewAsset(button.dataset.preview);
});

$('checkUpdate').onclick = async () => {
  const status = await loadStatus();
  notice(status.updateAvailable ? 'An update is available.' : 'You are up to date.');
};
$('updateNow').onclick = () => command('/api/update', 'Update started.').catch((error) => notice(error.message, true));
$('rollback').onclick = () => command('/api/rollback', 'Rollback started.').catch((error) => notice(error.message, true));
$('refreshLogs').onclick = () => loadLogs().catch((error) => notice(error.message, true));

load().catch((error) => notice(error.message, true));
setInterval(() => loadStatus().catch(() => {}), 15000);
