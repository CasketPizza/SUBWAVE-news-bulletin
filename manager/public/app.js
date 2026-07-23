const $ = (id) => document.getElementById(id);
let model = null;
let assets = {};
let options = {};
let instructionDefaults = {};
let noticeTimer = null;
let logRefreshTimer = null;
let logRequestInFlight = false;
let statusRequestPromise = null;
let interestModel = { profile: '', likes: [], dislikes: [], likeCount: 0, dislikeCount: 0 };
let interestArticles = [];
let interestRatings = new Map();
let interestArticlesLoaded = false;
const INTEREST_PAGE_SIZE = 16;
let interestVisibleLimit = INTEREST_PAGE_SIZE;

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
  const interestDialog = $('interestDialog');
  if (interestDialog?.open) interestDialog.close();
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
  setInterestModel(payload.interests || {});

  $('feeds').innerHTML = '';
  model.feeds.forEach(feedRow);
  [
    'enabled', 'customMinute', 'timeZone', 'maxItemsPerFeed', 'maxCandidates',
    'maxHeadlines', 'storyPauseSeconds', 'interruptCurrentTrack', 'storySelectionInstructions',
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


function setInterestModel(value = {}) {
  interestModel = {
    profile: String(value.profile || ''),
    likes: Array.isArray(value.likes) ? value.likes : [],
    dislikes: Array.isArray(value.dislikes) ? value.dislikes : [],
    likeCount: Number(value.likeCount ?? value.likes?.length) || 0,
    dislikeCount: Number(value.dislikeCount ?? value.dislikes?.length) || 0,
    updatedAt: value.updatedAt || null,
    generatedAt: value.generatedAt || null,
  };
  const profile = interestModel.profile.trim();
  $('interestProfileSummary').textContent = profile || 'No interest profile yet. Important news and the written selection instructions remain in control.';
  $('interestExampleCount').textContent = `${interestModel.likeCount} preferred · ${interestModel.dislikeCount} de-emphasised examples`;
  $('interestProfileEditor').value = profile;
}

function setInterestStatus(message, error = false) {
  const box = $('interestStatusMessage');
  box.textContent = message || '';
  box.classList.toggle('error', Boolean(error));
}

function articleDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function ratingFor(key) {
  return interestRatings.get(key) || 'neutral';
}

function updateInterestCounts() {
  let likes = 0;
  let dislikes = 0;
  for (const article of interestArticles) {
    const rating = ratingFor(article.key);
    if (rating === 'like') likes += 1;
    if (rating === 'dislike') dislikes += 1;
  }
  $('interestSelectionCount').textContent = `${likes} preferred · ${dislikes} de-emphasised`;
}

function renderInterestArticles({ preserveScroll = true } = {}) {
  const list = $('interestArticles');
  const previousScrollTop = preserveScroll ? list.scrollTop : 0;
  const query = $('interestSearch').value.trim().toLowerCase();
  const source = $('interestSourceFilter').value;
  const ratingFilter = $('interestRatingFilter').value;
  const matching = interestArticles.filter((article) => {
    const rating = ratingFor(article.key);
    const haystack = `${article.title || ''} ${article.summary || article.description || ''}`.toLowerCase();
    return (!source || article.source === source)
      && (!ratingFilter || rating === ratingFilter)
      && (!query || haystack.includes(query));
  });
  const shown = matching.slice(0, interestVisibleLimit);

  list.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = interestArticles.length ? 'No articles match the current filters.' : 'No articles are available.';
    list.appendChild(empty);
    list.scrollTop = 0;
    updateInterestCounts();
    return;
  }

  for (const article of shown) {
    const rating = ratingFor(article.key);
    const card = document.createElement('article');
    card.className = `interest-article rating-${rating}`;
    const summary = article.summary || article.description || '';
    const headline = article.link
      ? `<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a>`
      : escapeHtml(article.title);
    card.innerHTML = `
      <div class="interest-meta"><span>${escapeHtml(article.source || 'Unknown source')}</span>${article.published ? `<time>${escapeHtml(articleDate(article.published))}</time>` : ''}</div>
      <h3>${headline}</h3>
      <p class="interest-summary ${summary ? '' : 'missing'}">${summary ? escapeHtml(summary) : 'No complete summary was supplied by this feed. The editor will use only the full headline rather than an incomplete teaser.'}</p>
      <div class="interest-rating" role="group" aria-label="Rate this article as an interest example">
        <button type="button" data-interest-key="${escapeHtml(article.key)}" data-interest-rating="like" aria-pressed="${rating === 'like'}">More like this</button>
        <button type="button" data-interest-key="${escapeHtml(article.key)}" data-interest-rating="dislike" aria-pressed="${rating === 'dislike'}">Less like this</button>
        <button type="button" data-interest-key="${escapeHtml(article.key)}" data-interest-rating="neutral" aria-pressed="${rating === 'neutral'}">Neutral</button>
      </div>`;
    list.appendChild(card);
  }

  if (shown.length < matching.length) {
    const remaining = matching.length - shown.length;
    const nextCount = Math.min(INTEREST_PAGE_SIZE, remaining);
    const more = document.createElement('div');
    more.className = 'interest-load-more';
    more.innerHTML = `
      <span>Showing ${shown.length} of ${matching.length} matching articles</span>
      <button type="button" id="loadMoreInterestArticles">Load ${nextCount} more</button>`;
    list.appendChild(more);
    more.querySelector('button').onclick = () => {
      interestVisibleLimit += INTEREST_PAGE_SIZE;
      renderInterestArticles({ preserveScroll: true });
    };
  }

  list.querySelectorAll('[data-interest-rating]').forEach((button) => {
    button.onclick = () => {
      interestRatings.set(button.dataset.interestKey, button.dataset.interestRating);
      renderInterestArticles({ preserveScroll: true });
    };
  });
  list.scrollTop = previousScrollTop;
  updateInterestCounts();
}

function resetInterestPagination() {
  interestVisibleLimit = INTEREST_PAGE_SIZE;
  renderInterestArticles({ preserveScroll: false });
}

function populateInterestSources() {
  const select = $('interestSourceFilter');
  const previous = select.value;
  select.innerHTML = '<option value="">All sources</option>';
  const sources = [...new Set(interestArticles.map((item) => item.source).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  for (const source of sources) select.appendChild(optionElement(source, source));
  if ([...select.options].some((item) => item.value === previous)) select.value = previous;
}

async function loadInterestArticles(force = false) {
  if (interestArticlesLoaded && !force) {
    renderInterestArticles();
    return;
  }
  const button = $('refreshInterestArticles');
  button.disabled = true;
  setInterestStatus('Loading recent articles from the configured feeds…');
  $('interestArticles').innerHTML = '<p class="empty-state">Loading recent articles…</p>';
  try {
    const pendingRatings = new Map(interestRatings);
    const payload = await api(`/api/interests/articles?refresh=${force ? 1 : 0}`);
    interestArticles = Array.isArray(payload.items) ? payload.items : [];
    interestRatings = new Map(Object.entries(payload.ratings || {}));
    // A manual refresh should not silently throw away choices made since the
    // popup was opened. Keep pending local ratings for articles still present.
    for (const article of interestArticles) {
      if (pendingRatings.has(article.key)) interestRatings.set(article.key, pendingRatings.get(article.key));
    }
    interestArticlesLoaded = true;
    interestVisibleLimit = INTEREST_PAGE_SIZE;
    populateInterestSources();
    $('interestArticleFreshness').textContent = payload.cached
      ? `Cached feed results${payload.updatedAt ? ` from ${articleDate(payload.updatedAt)}` : ''}`
      : `Updated ${payload.updatedAt ? articleDate(payload.updatedAt) : 'now'}`;
    setInterestStatus(`${interestArticles.length} recent articles loaded. Rate broad examples, then generate the profile once.`);
    renderInterestArticles({ preserveScroll: false });
  } catch (error) {
    setInterestStatus(error.message, true);
    $('interestArticles').innerHTML = '<p class="empty-state">Articles could not be loaded. Check Recent actions for feed errors.</p>';
  } finally {
    button.disabled = false;
  }
}

function interestSelectionPayload() {
  return {
    visibleKeys: interestArticles.map((article) => article.key),
    selections: interestArticles
      .filter((article) => ['like', 'dislike'].includes(ratingFor(article.key)))
      .map((article) => ({
        key: article.key,
        rating: ratingFor(article.key),
        title: article.title,
        source: article.source,
        summary: article.summary || article.description || '',
        link: article.link || '',
        published: article.published || '',
        selectedAt: new Date().toISOString(),
      })),
  };
}

async function generateInterestProfileFromChoices() {
  const button = $('generateInterestProfile');
  button.disabled = true;
  setInterestStatus('Generating a concise interest profile with the configured SUB/WAVE LLM. This may take a minute.');
  try {
    const result = await api('/api/interests/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(interestSelectionPayload()),
    });
    setInterestModel(result.interests || {});
    setInterestStatus('Interest profile generated and saved. It will influence future selection only as a soft tie-breaker.');
    notice('Audience interest profile updated.');
  } catch (error) {
    setInterestStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function saveEditedInterestProfile() {
  const button = $('saveInterestProfile');
  button.disabled = true;
  try {
    const result = await api('/api/interests/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: $('interestProfileEditor').value }),
    });
    setInterestModel(result.interests || {});
    setInterestStatus('Edited profile saved.');
    notice('Audience interest profile saved.');
  } catch (error) {
    setInterestStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function resetAllInterests() {
  if (!window.confirm('Reset the generated profile and every saved More like this / Less like this example?')) return;
  try {
    const result = await api('/api/interests', { method: 'DELETE' });
    setInterestModel(result.interests || {});
    interestRatings.clear();
    renderInterestArticles();
    setInterestStatus('All saved interests were reset.');
    notice('Audience interests reset.');
  } catch (error) {
    setInterestStatus(error.message, true);
  }
}

async function openInterestTuner() {
  const dialog = $('interestDialog');
  if (!dialog.open) dialog.showModal();
  $('interestProfileEditor').value = interestModel.profile || '';
  await loadInterestArticles(false);
}

function closeInterestTuner() {
  $('interestDialog').close();
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
  $('managerStatus').textContent = status.busy
    ? 'Preparing bulletin…'
    : status.bulletinOnAir
      ? `Bulletin on air — protected${status.bulletinPlaybackRemainingSeconds ? ` (${status.bulletinPlaybackRemainingSeconds}s)` : ''}`
      : 'Running';
  $('runNow').disabled = Boolean(status.busy || status.bulletinOnAir);
  $('runNow').textContent = status.bulletinOnAir ? 'Bulletin on air' : 'Run bulletin now';
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


$('tuneInterests').onclick = () => openInterestTuner().catch((error) => setInterestStatus(error.message, true));
$('closeInterests').onclick = closeInterestTuner;
$('closeInterestsTop').onclick = closeInterestTuner;
$('refreshInterestArticles').onclick = () => loadInterestArticles(true);
$('interestSearch').oninput = resetInterestPagination;
$('interestSourceFilter').onchange = resetInterestPagination;
$('interestRatingFilter').onchange = resetInterestPagination;
$('generateInterestProfile').onclick = generateInterestProfileFromChoices;
$('saveInterestProfile').onclick = saveEditedInterestProfile;
$('resetInterests').onclick = resetAllInterests;
$('interestDialog').addEventListener('click', (event) => {
  if (event.target === $('interestDialog')) closeInterestTuner();
});

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
    await loadStatus().catch(() => {});
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
