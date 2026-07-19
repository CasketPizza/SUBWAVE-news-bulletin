import express from 'express';
import multer from 'multer';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import {
  mkdir, readFile, writeFile, rename, rm, readdir,
} from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 7711);
const EXTENSION_DIR = resolve(process.env.EXTENSION_DIR || '/opt/subwave-news-bulletin');
const SUBWAVE_DIR = resolve(process.env.SUBWAVE_DIR || '/opt/subwave');
const STATE_DIR = resolve(process.env.STATE_DIR || '/var/sub-wave');
const DATA_DIR = join(STATE_DIR, 'extensions/hourly-news');
const ASSET_DIR = join(DATA_DIR, 'assets');
const GENERATED_DIR = join(DATA_DIR, 'generated');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const SEEN_FILE = join(DATA_DIR, 'seen.json');
const LOG_FILE = join(DATA_DIR, 'manager.log');
const SAY_FILE = join(STATE_DIR, 'say.txt');
const SUPPRESS_FILE = join(DATA_DIR, 'suppress-hourly');
const SKILL_FILE = join(STATE_DIR, 'skills/hourly-news-bulletin/SKILL.md');
const GITHUB_REPO = process.env.GITHUB_REPO || 'CasketPizza/SUBWAVE-news-bulletin';
const CONTROLLER_URL = process.env.CONTROLLER_URL || 'http://controller:7701';

const DEFAULTS = {
  enabled: true,
  scheduleMode: 'after',
  customMinute: 0,
  afterDelaySeconds: 30,
  timeZone: process.env.TZ || 'Australia/Sydney',
  feeds: [
    { name: 'Guardian Australia', url: 'https://www.theguardian.com/australia-news/rss' },
    { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  ],
  maxItemsPerFeed: 8,
  maxCandidates: 12,
  maxHeadlines: 5,
  maxLengthSeconds: 60,
  bedVolumeDb: -18,
  bedFadeIn: 0.75,
  bedFadeOut: 1.5,
  loopBed: true,
  lastRunAt: null,
  lastRunStatus: null,
};

await Promise.all([
  mkdir(DATA_DIR, { recursive: true }),
  mkdir(ASSET_DIR, { recursive: true }),
  mkdir(GENERATED_DIR, { recursive: true }),
  mkdir(UPLOAD_DIR, { recursive: true }),
]);

function readEnv(path) {
  const out = {};
  try {
    const text = fs.readFileSync(path, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      let value = rest.join('=').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key.trim()] = value;
    }
  } catch {}
  return out;
}

const subwaveEnv = readEnv(join(SUBWAVE_DIR, '.env'));
const ADMIN_USER = process.env.ADMIN_USER || subwaveEnv.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || subwaveEnv.ADMIN_PASS || '';

function authHeader() {
  return `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64')}`;
}

function requireAuth(req, res, next) {
  if (!ADMIN_USER && !ADMIN_PASS) return next();
  if (req.headers.authorization === authHeader()) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="SUB/WAVE Hourly News"');
  return res.status(401).send('Authentication required');
}

async function loadJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return structuredClone(fallback);
  }
}

async function saveJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

async function settings() {
  return { ...DEFAULTS, ...(await loadJson(SETTINGS_FILE, DEFAULTS)) };
}

function cleanSettings(body) {
  const input = body && typeof body === 'object' ? body : {};
  const mode = ['after', 'before', 'replace', 'custom', 'manual'].includes(input.scheduleMode)
    ? input.scheduleMode : 'after';
  const feeds = (Array.isArray(input.feeds) ? input.feeds : [])
    .map((feed) => ({
      name: String(feed?.name || '').trim().slice(0, 100),
      url: String(feed?.url || '').trim().slice(0, 2000),
    }))
    .filter((feed) => feed.url)
    .slice(0, 20);

  for (const feed of feeds) {
    const url = new URL(feed.url);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Unsupported feed URL: ${feed.url}`);
    }
  }

  return {
    ...DEFAULTS,
    enabled: input.enabled !== false,
    scheduleMode: mode,
    customMinute: Math.min(59, Math.max(0, Number(input.customMinute) || 0)),
    afterDelaySeconds: Math.min(55, Math.max(5, Number(input.afterDelaySeconds) || 30)),
    timeZone: String(input.timeZone || DEFAULTS.timeZone).trim() || DEFAULTS.timeZone,
    feeds,
    maxItemsPerFeed: Math.min(30, Math.max(1, Number(input.maxItemsPerFeed) || 8)),
    maxCandidates: Math.min(30, Math.max(3, Number(input.maxCandidates) || 12)),
    maxHeadlines: Math.min(10, Math.max(1, Number(input.maxHeadlines) || 5)),
    maxLengthSeconds: Math.min(180, Math.max(20, Number(input.maxLengthSeconds) || 60)),
    bedVolumeDb: Math.min(0, Math.max(-40, Number(input.bedVolumeDb) || -18)),
    bedFadeIn: Math.min(10, Math.max(0, Number(input.bedFadeIn) || 0)),
    bedFadeOut: Math.min(10, Math.max(0, Number(input.bedFadeOut) || 0)),
    loopBed: input.loopBed !== false,
    lastRunAt: input.lastRunAt || null,
    lastRunStatus: input.lastRunStatus || null,
  };
}

async function syncSuppressFlag(config) {
  if (config.enabled && config.scheduleMode === 'replace') {
    await writeFile(SUPPRESS_FILE, 'replace\n');
  } else {
    await rm(SUPPRESS_FILE, { force: true });
  }
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  await writeFile(LOG_FILE, line, { flag: 'a' }).catch(() => {});
}

function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return String(value['#text'] || value.__cdata || value._ || '');
  return '';
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function parseFeed(xml, feed) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    cdataPropName: '__cdata',
  });
  const data = parser.parse(xml);
  const rssItems = asArray(data?.rss?.channel?.item);
  const atomItems = asArray(data?.feed?.entry);
  const items = rssItems.length ? rssItems : atomItems;

  return items.map((item) => {
    const link = typeof item.link === 'object'
      ? item.link?.['@_href'] || textValue(item.link)
      : textValue(item.link);
    return {
      source: feed.name || new URL(feed.url).hostname.replace(/^www\./, ''),
      title: textValue(item.title).replace(/\s+/g, ' ').trim(),
      description: textValue(item.description || item.summary || item.content)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700),
      link,
      published: textValue(item.pubDate || item.published || item.updated),
    };
  }).filter((item) => item.title);
}

async function fetchFeed(feed, maxItems) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'SUBWAVE-News-Bulletin/0.1 (+https://github.com/CasketPizza/SUBWAVE-news-bulletin)',
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return parseFeed(await response.text(), feed).slice(0, maxItems);
  } finally {
    clearTimeout(timer);
  }
}

async function collectHeadlines(config) {
  const settled = await Promise.allSettled(
    config.feeds.map((feed) => fetchFeed(feed, config.maxItemsPerFeed)),
  );
  const buckets = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.length) {
      buckets.push(result.value);
    } else if (result.status === 'rejected') {
      void log(`Feed failed: ${config.feeds[index].name || config.feeds[index].url}: ${result.reason?.message || result.reason}`);
    }
  });
  if (!buckets.length) throw new Error('All configured news feeds failed or returned no stories.');

  const seenLedger = await loadJson(SEEN_FILE, { keys: [] });
  const old = new Set(Array.isArray(seenLedger.keys) ? seenLedger.keys : []);
  const local = new Set();
  const merged = [];

  for (let row = 0; merged.length < config.maxCandidates * 3; row++) {
    let found = false;
    for (const bucket of buckets) {
      const item = bucket[row];
      if (!item) continue;
      found = true;
      const key = hash(item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
      if (!key || local.has(key) || old.has(key)) continue;
      local.add(key);
      merged.push({ ...item, key });
    }
    if (!found) break;
  }
  return { candidates: merged.slice(0, config.maxCandidates), ledger: old };
}

async function skillBrief() {
  try {
    const raw = await readFile(SKILL_FILE, 'utf8');
    return raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  } catch {
    return 'Deliver a concise factual radio news bulletin from the supplied headlines.';
  }
}

async function renderVoice(config, candidates) {
  const brief = await skillBrief();
  const rows = candidates.map((item, index) => (
    `${index + 1}. [${item.source}] ${item.title}${item.description ? ` — ${item.description}` : ''}`
  )).join('\n');

  const instruction = `${brief}

Use no more than ${config.maxHeadlines} stories and keep the script under approximately ${config.maxLengthSeconds} seconds when spoken.

Fresh candidate headlines:
${rows}

Return only the spoken bulletin. Do not include stage directions, labels, bullet numbers, URLs, or notes to the operator.`;

  const response = await fetch(`${CONTROLLER_URL}/dj/render-voice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(),
    },
    body: JSON.stringify({ text: instruction, mode: 'styled', kind: 'dj-speak' }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SUB/WAVE render failed (${response.status}): ${text}`);
  const body = JSON.parse(text);
  if (!body.wavPath || !body.spoken) throw new Error('SUB/WAVE returned no rendered voice.');
  return body;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function durationOf(path) {
  const value = run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ]);
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Could not determine audio duration: ${path}`);
  }
  return seconds;
}

async function makeBulletinAudio(config, voicePath) {
  const out = join(GENERATED_DIR, `bulletin-${Date.now()}.wav`);
  const bed = join(ASSET_DIR, 'bed.wav');
  const duration = durationOf(voicePath);

  if (!existsSync(bed)) {
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', voicePath, '-ar', '44100', '-ac', '2',
      '-c:a', 'pcm_s16le', out,
    ]);
    return out;
  }

  const fadeIn = Math.min(config.bedFadeIn, duration / 3);
  const fadeOut = Math.min(config.bedFadeOut, duration / 3);
  const fadeOutStart = Math.max(0, duration - fadeOut);
  const loopArgs = config.loopBed ? ['-stream_loop', '-1'] : [];
  const filter = `[0:a]atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${config.bedVolumeDb}dB,afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}[bed];[bed][1:a]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[out]`;

  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...loopArgs, '-i', bed, '-i', voicePath,
    '-filter_complex', filter,
    '-map', '[out]', '-t', duration.toFixed(3),
    '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

async function waitUntilMissing(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${basename(path)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
}

async function queueAudio(path) {
  if (!existsSync(path)) return;
  await waitUntilMissing(SAY_FILE);
  const tmp = join(STATE_DIR, `.hourly-news-say-${process.pid}-${Date.now()}.tmp`);
  await writeFile(tmp, `${path}\n`);
  await rename(tmp, SAY_FILE);
  await waitUntilMissing(SAY_FILE);
}

let runBusy = false;
async function runBulletin(reason = 'manual') {
  if (runBusy) throw new Error('A bulletin is already being prepared.');
  runBusy = true;
  const config = await settings();
  try {
    await log(`Bulletin started (${reason}).`);
    const { candidates, ledger } = await collectHeadlines(config);
    if (!candidates.length) throw new Error('There are no fresh headlines to read.');

    const rendered = await renderVoice(config, candidates);
    const bulletin = await makeBulletinAudio(config, rendered.wavPath);
    const intro = join(ASSET_DIR, 'intro.wav');
    const outro = join(ASSET_DIR, 'outro.wav');

    if (existsSync(intro)) await queueAudio(intro);
    await queueAudio(bulletin);
    if (existsSync(outro)) await queueAudio(outro);

    for (const item of candidates) ledger.add(item.key);
    await saveJson(SEEN_FILE, {
      keys: Array.from(ledger).slice(-500),
      updatedAt: new Date().toISOString(),
    });

    const latest = {
      ...config,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: 'ok',
    };
    await saveJson(SETTINGS_FILE, latest);
    await log(`Bulletin completed: ${rendered.spoken}`);
    return { ok: true, spoken: rendered.spoken };
  } catch (error) {
    const latest = {
      ...config,
      lastRunAt: new Date().toISOString(),
      lastRunStatus: `error: ${error.message}`,
    };
    await saveJson(SETTINGS_FILE, latest).catch(() => {});
    await log(`Bulletin failed: ${error.message}`);
    throw error;
  } finally {
    runBusy = false;
    try {
      const names = (await readdir(GENERATED_DIR))
        .filter((name) => name.endsWith('.wav'))
        .sort()
        .reverse();
      await Promise.all(names.slice(8).map((name) => rm(join(GENERATED_DIR, name), { force: true })));
    } catch {}
  }
}

function zonedParts(timeZone) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second),
  };
}

let lastScheduleKey = '';
async function scheduleTick() {
  const config = await settings();
  await syncSuppressFlag(config);
  if (!config.enabled || config.scheduleMode === 'manual' || runBusy) return;

  let parts;
  try {
    parts = zonedParts(config.timeZone);
  } catch (error) {
    await log(`Invalid timezone "${config.timeZone}": ${error.message}`);
    return;
  }

  let due = false;
  let slotHour = parts.hour;
  if (config.scheduleMode === 'after') {
    due = parts.minute === 0 && parts.second >= config.afterDelaySeconds;
  } else if (config.scheduleMode === 'before') {
    due = parts.minute === 59 && parts.second >= 20;
    slotHour = (parts.hour + 1) % 24;
  } else if (config.scheduleMode === 'replace') {
    due = parts.minute === 0 && parts.second >= 2;
  } else if (config.scheduleMode === 'custom') {
    due = parts.minute === config.customMinute && parts.second >= 2;
  }

  const key = `${parts.year}-${parts.month}-${parts.day}-${slotHour}-${config.scheduleMode}`;
  if (due && key !== lastScheduleKey) {
    lastScheduleKey = key;
    runBulletin(`schedule:${config.scheduleMode}`).catch((error) => log(error.message));
  }
}

setInterval(() => {
  scheduleTick().catch((error) => log(`Scheduler error: ${error.message}`));
}, 5000);
await scheduleTick();

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024 },
});

async function convertUpload(file, type) {
  if (!['intro', 'bed', 'outro'].includes(type)) throw new Error('Unknown asset type.');
  const out = join(ASSET_DIR, `${type}.wav`);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', file.path, '-ar', '44100', '-ac', '2',
    '-c:a', 'pcm_s16le', out,
  ]);
  await rm(file.path, { force: true });
  return out;
}

function git(args) {
  return run('git', ['-C', EXTENSION_DIR, ...args]);
}

async function versionStatus() {
  let installedCommit = null;
  let latestCommit = null;
  let version = 'unknown';
  try { installedCommit = git(['rev-parse', 'HEAD']); } catch {}
  try { version = (await readFile(join(EXTENSION_DIR, 'VERSION'), 'utf8')).trim(); } catch {}
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/commits/main`, {
      headers: { 'User-Agent': 'SUBWAVE-News-Bulletin' },
    });
    if (response.ok) latestCommit = (await response.json()).sha;
  } catch {}
  return {
    version,
    installedCommit,
    latestCommit,
    updateAvailable: Boolean(installedCommit && latestCommit && installedCommit !== latestCommit),
  };
}

function startManage(command) {
  const child = spawn('bash', [join(EXTENSION_DIR, 'manage.sh'), command], {
    detached: true,
    stdio: 'ignore',
    cwd: EXTENSION_DIR,
    env: { ...process.env },
  });
  child.unref();
}

const app = express();
app.use(requireAuth);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(import.meta.dirname, 'public')));

app.get('/api/settings', async (_req, res) => {
  const config = await settings();
  const assets = {};
  for (const type of ['intro', 'bed', 'outro']) {
    assets[type] = existsSync(join(ASSET_DIR, `${type}.wav`));
  }
  res.json({ settings: config, assets });
});

app.put('/api/settings', async (req, res) => {
  try {
    const previous = await settings();
    const config = cleanSettings({ ...previous, ...req.body });
    await saveJson(SETTINGS_FILE, config);
    await syncSuppressFlag(config);
    res.json({ ok: true, settings: config });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/assets/:type', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new Error('Choose an audio file first.');
    await convertUpload(req.file, req.params.type);
    res.json({ ok: true });
  } catch (error) {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/assets/:type', async (req, res) => {
  if (!['intro', 'bed', 'outro'].includes(req.params.type)) {
    return res.status(400).send('Unknown asset.');
  }
  const path = join(ASSET_DIR, `${req.params.type}.wav`);
  if (!existsSync(path)) return res.status(404).send('No audio uploaded.');
  res.type('audio/wav').sendFile(path);
});

app.delete('/api/assets/:type', async (req, res) => {
  if (!['intro', 'bed', 'outro'].includes(req.params.type)) {
    return res.status(400).json({ error: 'Unknown asset.' });
  }
  await rm(join(ASSET_DIR, `${req.params.type}.wav`), { force: true });
  res.json({ ok: true });
});

app.post('/api/run', async (_req, res) => {
  try {
    res.json(await runBulletin('manual'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/status', async (_req, res) => {
  const config = await settings();
  const patch = spawnSync('python3', [
    join(EXTENSION_DIR, 'patches/patch_subwave.py'),
    'check', '--subwave-dir', SUBWAVE_DIR,
  ], { encoding: 'utf8' });
  res.json({
    manager: 'running',
    busy: runBusy,
    patchInstalled: patch.status === 0,
    lastRunAt: config.lastRunAt,
    lastRunStatus: config.lastRunStatus,
    ...(await versionStatus()),
  });
});

app.get('/api/logs', async (_req, res) => {
  try {
    const text = await readFile(LOG_FILE, 'utf8');
    res.type('text/plain').send(text.split(/\r?\n/).slice(-100).join('\n'));
  } catch {
    res.type('text/plain').send('');
  }
});

app.post('/api/update', (_req, res) => {
  startManage('update-internal');
  res.json({ ok: true, message: 'Update started. This page may disconnect while the manager restarts.' });
});

app.post('/api/reapply', (_req, res) => {
  startManage('reapply');
  res.json({ ok: true, message: 'Reapply started. The SUB/WAVE controller will restart.' });
});

app.post('/api/rollback', (_req, res) => {
  startManage('rollback');
  res.json({ ok: true, message: 'Rollback started. This page may disconnect while the manager restarts.' });
});

app.listen(PORT, '0.0.0.0', () => {
  log(`Hourly News Manager listening on port ${PORT}.`).catch(() => {});
});
