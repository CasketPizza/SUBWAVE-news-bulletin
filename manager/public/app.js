const $ = (id) => document.getElementById(id);
let model = null;
let assets = {};
let options = {};
let instructionDefaults = {};
let noticeTimer = null;
let logRefreshTimer = null;
let logRequestInFlight = false;
let statusRequestPromise = null;

// The manager is normally reverse-proxied below /news-bulletin/. Resolve every
// request relative to the page so the same build also works directly at /.
const APP_BASE = new URL('.', window.location.href).pathname.replace(/\/$/, '');
const localUrl = (path) => `${APP_BASE}${path.startsWith('/') ? path : `/${path}`}`;

class AuthenticationRequiredError extends Error {
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

function showAuthenticationRequired(message = '') {
  const panel = $('authRequired');
  const text = $('authMessage');
  if (text && message) text.textContent = message;
  if (panel) panel.classList.remove('hidden');
  document.body.classList.add('auth-required');
}

function hideAuthenticationRequired() {
  $('authRequired')?.classList.add('hidden');
  document.body.classList.remove('auth-required');
}

function beginReauthentication() {
  window.location.assign(localUrl(`/reauth?cache=${Date.now()}`));
}

function notice(message, error = false) {
  const box = $('notice');
  box.textContent = message;
  box.classList.remove('hidden', 'error');
  if (error) box.classList.add('error');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => box.classList.add('hidden'), 10000);
}

async function api(path, fetchOptions = {}) {
  const response = await fetch(localUrl(path), {
    cache: 'no-store',
    credentials: 'same-origin',
    ...fetchOptions,
    headers: {
      ...(fetchOptions.headers || {}),
      'Cache-Control': 'no-cache',
    },
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();

  if (response.status === 401 || response.status === 403) {
    showAuthenticationRequired('Your SUB/WAVE admin authentication is missing or no longer accepted. Re-authenticate to continue.');
    throw new AuthenticationRequiredError();
  }

  // An upstream login/access gateway may answer an API request with a successful
  // HTML page. Treat that as an authentication interruption instead of allowing
  // the UI to fail later with a vague JavaScript error.
  if (path.startsWith('/api/') && type.includes('text/html')) {
    showAuthenticationRequired('The manager received a login page instead of API data. Re-authenticate to continue.');
    throw new AuthenticationRequiredError('Login page returned instead of API data');
  }

  if (!response.ok) throw new Error(body?.error || body || `${response.status}`);
  return body;
}

async function managerWatchdog() {
  const healthResponse = await fetch(localUrl(`/health?cache=${Date.now()}`), {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!healthResponse.ok) throw new Error(`Manager health check returned HTTP ${healthResponse.status}`);
  await api('/api/auth-check');
  hideAuthenticationRequired();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
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
  if (!element) return;
  if (element.type === 'checkbox') element.checked = Boolean(value);
  else element.value = value ?? '';
}

function optionElement(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function engineLabel(engine) {
  const labels = {
    piper: 'Piper',
    kokoro: 'Kokoro',
    chatterbox: 'Chatterbox',
    'pocket-tts': 'PocketTTS',
    cloud: 'Cloud TTS',
    remote: 'Remote TTS',
  };
  return labels[engine] || engine;
}

function populatePresenterOptions() {
  const select = $('presenterSelect');
  select.innerHTML = '';
  const onAir = (options.personas || []).find((persona) => persona.id === options.onAirPersonaId);
  select.appendChild(optionElement(
    'on-air',
    onAir ? `Follow current on-air persona (${onAir.name})` : 'Follow the current on-air persona',
  ));

  for (const persona of options.personas || []) {
    const voice = persona.tts?.voice ? ` — ${persona.tts.voice}` : '';
    select.appendChild(optionElement(`persona:${persona.id}`, `${persona.name}${voice}`));
  }

  const wanted = model.presenterMode === 'persona' && model.presenterPersonaId
    ? `persona:${model.presenterPersonaId}`
    : 'on-air';
  if (![...select.options].some((item) => item.value === wanted) && wanted !== 'on-air') {
    select.appendChild(optionElement(wanted, 'Previously selected persona (not currently available)'));
  }
  select.value = wanted;
}

function populateEngineOptions() {
  const select = $('voiceEngine');
  select.innerHTML = '';
  const engines = Array.isArray(options.engines) && options.engines.length
    ? options.engines
    : ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'];
  for (const engine of engines) select.appendChild(optionElement(engine, engineLabel(engine)));
  if (![...select.options].some((item) => item.value === model.voiceEngine)) {
    select.appendChild(optionElement(model.voiceEngine, engineLabel(model.voiceEngine)));
  }
  select.value = model.voiceEngine || 'piper';
}

function populateCloudProviders() {
  const select = $('voiceCloudProvider');
  select.innerHTML = '';
  const providers = Array.isArray(options.cloudProviders) && options.cloudProviders.length
    ? options.cloudProviders
    : ['openai', 'elevenlabs', 'openai-compatible'];
  for (const provider of providers) select.appendChild(optionElement(provider, provider));
  if (model.voiceCloudProvider && ![...select.options].some((item) => item.value === model.voiceCloudProvider)) {
    select.appendChild(optionElement(model.voiceCloudProvider, model.voiceCloudProvider));
  }
  select.value = model.voiceCloudProvider || providers[0] || 'openai';
}

function refreshVoiceDatalist() {
  const engine = $('voiceEngine').value;
  const list = $('voiceNames');
  list.innerHTML = '';
  const voiceOptions = options.voices?.[engine] || [];
  for (const voice of voiceOptions) {
    const item = document.createElement('option');
    item.value = typeof voice === 'string' ? voice : voice.id;
    item.label = typeof voice === 'string' ? voice : (voice.label || voice.id);
    list.appendChild(item);
  }
  $('cloudProviderLabel').classList.toggle('hidden', engine !== 'cloud');
}

function updateVoiceRouting() {
  const override = $('voiceMode').value === 'override';
  $('voiceOverride').classList.toggle('hidden', !override);
  if (override) refreshVoiceDatalist();
}

async function load() {
  const payload = await api('/api/settings');
  model = payload.settings;
  assets = payload.assets;
  options = payload.options || {};
  instructionDefaults = payload.defaults || {};

  $('feeds').innerHTML = '';
  model.feeds.forEach(feedRow);
  [
    'enabled', 'customMinute', 'timeZone', 'maxItemsPerFeed', 'maxCandidates',
    'maxHeadlines', 'maxLengthSeconds', 'storyPauseSeconds', 'interruptCurrentTrack', 'storySelectionInstructions',
    'articleHandlingInstructions', 'deliveryInstructions', 'voiceMode',
    'voiceName', 'voiceSpeed', 'voiceLanguage', 'bedVolumeDb', 'bedFadeIn',
    'bedFadeOut', 'loopBed',
  ].forEach((id) => setValue(id, model[id]));

  populatePresenterOptions();
  populateEngineOptions();
  populateCloudProviders();
  refreshVoiceDatalist();
  updateVoiceRouting();

  const selected = document.querySelector(`input[name=scheduleMode][value="${model.scheduleMode}"]`);
  if (selected) selected.checked = true;
  updateAssetStates();
  await loadStatus();
}

function collect() {
  const presenterChoice = $('presenterSelect').value;
  const fixedPersona = presenterChoice.startsWith('persona:');
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
    storyPauseSeconds: Number($('storyPauseSeconds').value),
    interruptCurrentTrack: $('interruptCurrentTrack').checked,
    storySelectionInstructions: $('storySelectionInstructions').value,
    articleHandlingInstructions: $('articleHandlingInstructions').value,
    deliveryInstructions: $('deliveryInstructions').value,
    presenterMode: fixedPersona ? 'persona' : 'on-air',
    presenterPersonaId: fixedPersona ? presenterChoice.slice('persona:'.length) : '',
    voiceMode: $('voiceMode').value,
    voiceEngine: $('voiceEngine').value,
    voiceName: $('voiceName').value,
    voiceCloudProvider: $('voiceCloudProvider').value,
    voiceSpeed: Number($('voiceSpeed').value),
    voiceLanguage: $('voiceLanguage').value,
    bedVolumeDb: Number($('bedVolumeDb').value),
    bedFadeIn: Number($('bedFadeIn').value),
    bedFadeOut: Number($('bedFadeOut').value),
    loopBed: $('loopBed').checked,
  };
}

function assetRecord(type) {
  const value = assets[type];
  if (value && typeof value === 'object') return value;
  if (value === true) return { uploaded: true, fileName: `${type}.wav` };
  return null;
}

function updateAssetStates() {
  for (const type of ['intro', 'bed', 'outro']) {
    const state = $(`${type}State`);
    const asset = assetRecord(type);
    state.textContent = asset?.fileName || 'No audio uploaded';
    state.title = asset?.fileName || '';
    state.classList.toggle('ready', Boolean(asset));
  }
}

async function save() {
  const payload = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(collect()),
  });
  model = payload.settings;
  notice('Settings saved. The next bulletin will use the selected presenter, voice and newsroom instructions.');
  await loadStatus();
}

async function uploadAsset(type) {
  const input = $(`${type}File`);
  const file = input.files[0];
  if (!file) return;
  const state = $(`${type}State`);
  const previous = assets[type];
  input.disabled = true;
  state.textContent = `Uploading ${file.name}…`;
  state.classList.remove('ready');
  try {
    const form = new FormData();
    form.append('file', file);
    const result = await api(`/api/assets/${type}`, { method: 'POST', body: form });
    assets[type] = result.asset || { uploaded: true, fileName: file.name };
    updateAssetStates();
    notice(`${type === 'bed' ? 'Background music' : `${type} jingle`} uploaded and selected: ${file.name}`);
  } catch (error) {
    assets[type] = previous;
    updateAssetStates();
    throw error;
  } finally {
    input.value = '';
    input.disabled = false;
  }
}

async function removeAsset(type) {
  await api(`/api/assets/${type}`, { method: 'DELETE' });
  assets[type] = null;
  updateAssetStates();
  $('preview').classList.add('hidden');
  notice('Audio removed.');
}

function previewAsset(type) {
  if (!assetRecord(type)) return notice('No audio has been uploaded for that field.', true);
  const player = $('preview');
  player.src = localUrl(`/api/assets/${type}?t=${Date.now()}`);
  player.classList.remove('hidden');
  player.play();
}

async function loadStatus(forceUpdateCheck = false) {
  if (statusRequestPromise) {
    if (!forceUpdateCheck) {
      const status = await statusRequestPromise;
      return renderStatus(status);
    }
    try { await statusRequestPromise; } catch {}
  }

  const request = api(`/api/status${forceUpdateCheck ? '?refresh=1' : ''}`);
  statusRequestPromise = request;
  let status;
  try {
    status = await request;
  } finally {
    if (statusRequestPromise === request) statusRequestPromise = null;
  }
  return renderStatus(status);
}

function renderStatus(status) {
  $('managerStatus').textContent = status.busy ? 'Preparing bulletin…' : 'Running';
  $('versionStatus').textContent = status.updateAvailable
    ? `${status.version}${status.latestVersion ? ` → ${status.latestVersion}` : ''} — update available`
    : status.updateCheckError
      ? `${status.version} — update check unavailable`
      : status.version;
  $('versionStatus').title = [
    status.installedCommit ? `Installed: ${status.installedCommit.slice(0, 12)}` : '',
    status.latestCommit ? `Remote: ${status.latestCommit.slice(0, 12)}` : '',
    status.updateCheckedAt ? `Checked: ${new Date(status.updateCheckedAt).toLocaleString()}` : '',
  ].filter(Boolean).join(' | ');
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
  if (logRequestInFlight) return;
  logRequestInFlight = true;
  const panel = $('logs');
  const previousScrollTop = panel.scrollTop;
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 32;
  try {
    const text = await api('/api/logs');
    const display = text || 'No recent actions.';
    if (panel.textContent === display) return;
    panel.textContent = display;
    if (nearBottom || panel.dataset.loaded !== '1') panel.scrollTop = panel.scrollHeight;
    else panel.scrollTop = previousScrollTop;
    panel.dataset.loaded = '1';
  } finally {
    logRequestInFlight = false;
  }
}

function setLogAutoRefresh() {
  clearInterval(logRefreshTimer);
  logRefreshTimer = null;
  if (!$('liveLogs').checked || document.visibilityState !== 'visible') return;
  loadLogs().catch(() => {});
  logRefreshTimer = setInterval(() => loadLogs().catch(() => {}), 5000);
}

async function command(path, message) {
  const result = await api(path, { method: 'POST' });
  notice(result.message || message);
}

$('addFeed').onclick = () => feedRow();
$('save').onclick = () => save().catch((error) => notice(error.message, true));
$('voiceMode').onchange = updateVoiceRouting;
$('voiceEngine').onchange = refreshVoiceDatalist;
$('resetInstructions').onclick = () => {
  setValue('storySelectionInstructions', instructionDefaults.storySelectionInstructions || '');
  setValue('articleHandlingInstructions', instructionDefaults.articleHandlingInstructions || '');
  setValue('deliveryInstructions', instructionDefaults.deliveryInstructions || '');
  notice('Instruction defaults restored in the form. Press Save settings to apply them.');
};

$('runNow').onclick = async () => {
  $('runNow').disabled = true;
  notice('Preparing the bulletin. This can take a minute.');
  try {
    const result = await api('/api/run', { method: 'POST' });
    const freshness = result.freshness === 'fresh' ? 'new headlines'
      : result.freshness === 'cached' ? 'cached recap' : 'current-headlines recap';
    notice(`Bulletin queued (${freshness}, ${result.storyCount || 1} stories): ${result.spoken}`);
    await load();
  } catch (error) {
    notice(error.message, true);
  } finally {
    $('runNow').disabled = false;
  }
};

for (const type of ['intro', 'bed', 'outro']) {
  $(`${type}File`).onchange = () => uploadAsset(type).catch((error) => notice(error.message, true));
}
document.querySelectorAll('[data-remove]').forEach((button) => {
  button.onclick = () => removeAsset(button.dataset.remove).catch((error) => notice(error.message, true));
});
document.querySelectorAll('[data-preview]').forEach((button) => {
  button.onclick = () => previewAsset(button.dataset.preview);
});

$('checkUpdate').onclick = async () => {
  const button = $('checkUpdate');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const status = await loadStatus(true);
    if (status.updateCheckError) {
      notice(`Could not check for updates: ${status.updateCheckError}`, true);
    } else if (status.updateAvailable) {
      notice(`Update available${status.latestVersion ? `: ${status.version} → ${status.latestVersion}` : '.'}`);
    } else {
      notice(`You are up to date${status.version ? ` (${status.version})` : ''}.`);
    }
  } catch (error) {
    notice(`Could not check for updates: ${error.message}`, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
};
$('updateNow').onclick = () => command('/api/update', 'Update started.').catch((error) => notice(error.message, true));
$('rollback').onclick = () => command('/api/rollback', 'Rollback started.').catch((error) => notice(error.message, true));
$('refreshProxy').onclick = () => command('/api/proxy/refresh', 'SUB/WAVE path refreshed.').catch((error) => notice(error.message, true));
$('refreshLogs').onclick = () => loadLogs().catch((error) => notice(error.message, true));
$('clearLogs').onclick = async () => {
  try {
    const result = await api('/api/logs', { method: 'DELETE' });
    $('logs').textContent = 'No recent actions.';
    $('logs').dataset.loaded = '1';
    notice(result.message || 'Recent actions cleared.');
  } catch (error) {
    notice(error.message, true);
  }
};
$('liveLogs').onchange = () => {
  setLogAutoRefresh();
  if (!$('liveLogs').checked) notice('Live debugging paused.');
};
$('reauthenticate').onclick = beginReauthentication;
$('retryConnection').onclick = async () => {
  $('retryConnection').disabled = true;
  try {
    await managerWatchdog();
    await load();
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) {
      showAuthenticationRequired(`The manager could not be reached: ${error.message}`);
    }
  } finally {
    $('retryConnection').disabled = false;
  }
};

document.addEventListener('visibilitychange', setLogAutoRefresh);
window.addEventListener('focus', setLogAutoRefresh);

async function bootstrap() {
  try {
    await managerWatchdog();
    await load();
    setLogAutoRefresh();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) return;
    showAuthenticationRequired(`The manager could not be reached: ${error.message}`);
  }
}

bootstrap();
setInterval(() => {
  if (document.visibilityState !== 'visible' || document.body.classList.contains('auth-required')) return;
  loadStatus().catch((error) => {
    if (!(error instanceof AuthenticationRequiredError)) notice(error.message, true);
  });
}, 30000);
