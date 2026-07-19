import express from 'express';
import multer from 'multer';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import {
  mkdir, readFile, writeFile, rename, rm, readdir, copyFile,
} from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 7711);
const EXTENSION_DIR = resolve(process.env.EXTENSION_DIR || '/opt/subwave-news-bulletin');
const SUBWAVE_DIR = resolve(process.env.SUBWAVE_DIR || '/opt/subwave');
const PROXY_REFRESH_SCRIPT = join(EXTENSION_DIR, 'proxy/refresh_proxy.sh');
const STATE_DIR = resolve(process.env.STATE_DIR || '/var/sub-wave');
const HOST_STATE_DIR = process.env.HOST_STATE_DIR || STATE_DIR;
const SUBWAVE_NETWORK = process.env.SUBWAVE_NETWORK || '';
const MANAGER_PORT = String(process.env.MANAGER_PORT || PORT);
const MANAGER_IMAGE = process.env.MANAGER_IMAGE || 'subwave-news-bulletin-manager:local';
const CONTROLLER_URL = (process.env.CONTROLLER_URL || 'http://controller:7701').replace(/\/$/, '');
const DATA_DIR = join(STATE_DIR, 'extensions/hourly-news');
const ASSET_DIR = join(DATA_DIR, 'assets');
const GENERATED_DIR = join(DATA_DIR, 'generated');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const SEEN_FILE = join(DATA_DIR, 'seen.json');
const LOG_FILE = join(DATA_DIR, 'manager.log');
const SAY_FILE = join(STATE_DIR, 'say.txt');
const SKILL_FILE = join(STATE_DIR, 'skills/hourly-news-bulletin/SKILL.md');
const RAW_SUBWAVE_SETTINGS = join(STATE_DIR, 'settings.json');
const SUBWAVE_SECRETS = join(STATE_DIR, 'secrets.env');
const GITHUB_REPO = process.env.GITHUB_REPO || 'CasketPizza/SUBWAVE-news-bulletin';

const DEFAULTS = {
  enabled: true,
  scheduleMode: 'after',
  customMinute: 15,
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
  lastScheduleSlot: null,
};

await Promise.all([
  mkdir(DATA_DIR, { recursive: true }),
  mkdir(ASSET_DIR, { recursive: true }),
  mkdir(GENERATED_DIR, { recursive: true }),
  mkdir(UPLOAD_DIR, { recursive: true }),
]);

function readEnvFile(path) {
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

const stateSecrets = readEnvFile(SUBWAVE_SECRETS);
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

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
  const mode = ['after', 'before', 'custom', 'manual'].includes(input.scheduleMode)
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
    lastScheduleSlot: input.lastScheduleSlot || null,
  };
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
        'User-Agent': 'SUBWAVE-News-Bulletin/0.2 (+https://github.com/CasketPizza/SUBWAVE-news-bulletin)',
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

async function controllerRequest(path, options = {}) {
  const headers = { ...(options.headers || {}), Authorization: authHeader() };
  const response = await fetch(`${CONTROLLER_URL}${path}`, { ...options, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`SUB/WAVE ${path} failed (${response.status}): ${text || response.statusText}`);
  }
  return response;
}

async function subwaveSnapshot() {
  const response = await controllerRequest('/settings');
  const api = await response.json();
  const raw = await loadJson(RAW_SUBWAVE_SETTINGS, {});
  const values = api?.values || {};
  const personas = Array.isArray(values.personas) ? values.personas : [];
  const activeId = api?.onAir?.personaId || values.activePersonaId || raw.activePersonaId;
  const persona = personas.find((item) => item?.id === activeId) || personas[0] || {
    name: 'SUB/WAVE DJ', tagline: '', soul: '', humour: 5, localColour: 5, warmth: 5,
    language: 'English', tts: {},
  };
  return { api, raw, values, persona };
}

function toneLine(label, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n <= 3) return `${label}: low`;
  if (n >= 7) return `${label}: high`;
  return `${label}: balanced`;
}

function buildPrompts(snapshot, config, candidates, brief) {
  const { persona, values } = snapshot;
  const station = values.station || 'SUB/WAVE';
  const location = values.weather?.onAirLocation || values.weather?.locationName || '';
  const rows = candidates.map((item, index) => (
    `${index + 1}. [${item.source}] ${item.title}${item.description ? ` — ${item.description}` : ''}`
  )).join('\n');
  const tone = [
    toneLine('Humour', persona.humour),
    toneLine('Local colour', persona.localColour),
    toneLine('Warmth', persona.warmth),
  ].filter(Boolean).join('; ');

  const system = `You are ${persona.name || 'the DJ'}, the on-air presenter for ${station}.${location ? ` The station is based around ${location}.` : ''}
Persona tagline: ${persona.tagline || '(none)'}
Persona description: ${persona.soul || 'natural, concise radio presenter'}
Tone controls: ${tone || 'balanced'}
Language: ${persona.language || 'English'}

Output only words that should be spoken aloud. Do not output headings, bullets, stage directions, citations, URLs, markdown, or quotation marks around the script. Preserve the persona's voice, but accuracy and restraint outrank jokes during serious news.`;

  const user = `${brief}

Use no more than ${config.maxHeadlines} stories and keep the script under approximately ${config.maxLengthSeconds} seconds when spoken. Prioritise Australian news, followed by major world news. Only use facts present in the supplied candidates. Do not merge unrelated stories or invent context. Avoid jokes about death, disasters, victims, war, or serious crime.

Fresh candidate headlines:
${rows}

Return only the finished spoken bulletin.`;
  return { system, user };
}

function secret(name) {
  return process.env[name] || stateSecrets[name] || '';
}

function trimOutput(value) {
  return String(value || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^(?:script|bulletin|news bulletin)\s*:\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function providerKey(provider, rawLlm = {}) {
  const inline = rawLlm?.keys?.[provider] || '';
  if (inline && inline !== 'set') return inline;
  const envMap = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    requesty: 'REQUESTY_API_KEY',
    gateway: 'AI_GATEWAY_API_KEY',
  };
  return envMap[provider] ? secret(envMap[provider]) : '';
}

function baseUrlFor(provider, leg, rawLlm = {}) {
  const urls = leg?.providerBaseUrls || rawLlm?.providerBaseUrls || {};
  if (provider === 'locca') return (urls.locca || 'http://host.docker.internal:8080/v1').replace(/\/$/, '');
  if (provider === 'openai-compatible') return String(urls['openai-compatible'] || '').replace(/\/$/, '');
  if (provider === 'requesty') return String(urls.requesty || 'https://router.requesty.ai/v1').replace(/\/$/, '');
  if (provider === 'gateway') return String(urls.gateway || '').replace(/\/$/, '');
  return '';
}

async function fetchJson(url, init, timeoutMs = 45000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Provider returned invalid JSON: ${text.slice(0, 200)}`); }
}

async function generateWithLeg(leg, rawLlm, prompts) {
  const provider = String(leg?.provider || '').trim();
  const model = String(leg?.model || '').trim();
  if (!provider || !model) throw new Error('SUB/WAVE has no LLM provider/model configured.');
  const maxTokens = Math.max(256, Math.min(2048, Number(rawLlm?.maxOutputTokens) || 900));

  if (provider === 'ollama') {
    const base = String(leg.ollamaUrl || rawLlm.ollamaUrl || 'http://host.docker.internal:11434').replace(/\/$/, '');
    const body = await fetchJson(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: prompts.system },
          { role: 'user', content: prompts.user },
        ],
        options: {
          num_ctx: Number(leg.numCtx || rawLlm.numCtx) || undefined,
          repeat_penalty: Number(leg.repeatPenalty || rawLlm.repeatPenalty) || undefined,
          temperature: 0.35,
        },
      }),
    }, 90000);
    return trimOutput(body?.message?.content || body?.response);
  }

  if (provider === 'anthropic') {
    const key = providerKey(provider, rawLlm);
    if (!key) throw new Error('ANTHROPIC_API_KEY is not available to the companion.');
    const body = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.35,
        system: prompts.system,
        messages: [{ role: 'user', content: prompts.user }],
      }),
    });
    return trimOutput((body?.content || []).map((item) => item?.text || '').join('\n'));
  }

  if (provider === 'google') {
    const key = providerKey(provider, rawLlm);
    if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not available to the companion.');
    const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompts.system }] },
        contents: [{ role: 'user', parts: [{ text: prompts.user }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: maxTokens },
      }),
    });
    return trimOutput(body?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n'));
  }

  let base = '';
  let key = providerKey(provider, rawLlm);
  if (provider === 'openai') base = 'https://api.openai.com/v1';
  else if (provider === 'deepseek') base = 'https://api.deepseek.com/v1';
  else if (provider === 'openrouter') base = 'https://openrouter.ai/api/v1';
  else if (['openai-compatible', 'locca', 'requesty', 'gateway'].includes(provider)) {
    base = baseUrlFor(provider, leg, rawLlm);
    if (!base) throw new Error(`${provider} has no base URL configured.`);
  } else {
    throw new Error(`The companion does not yet support SUB/WAVE LLM provider "${provider}".`);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const body = await fetchJson(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user },
      ],
    }),
  });
  return trimOutput(body?.choices?.[0]?.message?.content);
}

async function generateBulletinText(snapshot, config, candidates) {
  const brief = await skillBrief();
  const prompts = buildPrompts(snapshot, config, candidates, brief);
  const rawLlm = snapshot.raw?.llm || {};
  const apiLlm = snapshot.values?.llm || {};
  const primary = { ...rawLlm, ...apiLlm };
  try {
    const text = await generateWithLeg(primary, rawLlm, prompts);
    if (!text) throw new Error('The configured LLM returned an empty bulletin.');
    return { text, provider: primary.provider, model: primary.model };
  } catch (primaryError) {
    const fallbackRaw = rawLlm?.fallback || {};
    const fallbackApi = apiLlm?.fallback || {};
    const fallback = { ...fallbackRaw, ...fallbackApi };
    if (!fallback.enabled) throw primaryError;
    await log(`Primary LLM failed; trying fallback: ${primaryError.message}`);
    const text = await generateWithLeg(fallback, rawLlm, prompts);
    if (!text) throw new Error('The configured fallback LLM returned an empty bulletin.');
    return { text, provider: fallback.provider, model: fallback.model };
  }
}

function resolveVoice(snapshot) {
  const persona = snapshot.persona || {};
  const stationTts = snapshot.values?.tts || {};
  const requested = persona.tts || {};
  const engine = requested.engine || stationTts.defaultEngine || 'piper';
  let voice = requested.voice || '';
  if (!voice && engine === 'kokoro') voice = stationTts.kokoro?.voice || '';
  if (!voice && engine === 'chatterbox') voice = stationTts.chatterbox?.referenceVoice || '';
  if (!voice && engine === 'pocket-tts') voice = stationTts.pocketTts?.voice || '';
  if (!voice && engine === 'cloud') voice = stationTts.cloud?.voice || '';
  const cloudProvider = requested.cloudProvider || stationTts.cloud?.provider || 'openai';
  const engineSpeed = Number(stationTts.speed?.[engine]) || 1;
  const personaSpeed = Number(requested.speed) || 1;
  const speed = Math.min(2, Math.max(0.5, engineSpeed * personaSpeed));
  return {
    engine,
    voice,
    cloudProvider,
    speed,
    language: persona.language || 'English',
    voiceSettings: stationTts.cloud ? {
      voiceStability: stationTts.cloud.voiceStability,
      voiceStyle: stationTts.cloud.voiceStyle,
      voiceSimilarityBoost: stationTts.cloud.voiceSimilarityBoost,
      voiceUseSpeakerBoost: stationTts.cloud.voiceUseSpeakerBoost,
    } : undefined,
  };
}

async function synthesizeVoice(snapshot, text) {
  const voice = resolveVoice(snapshot);
  const response = await controllerRequest('/settings/tts/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...voice, text }),
  });
  const contentType = response.headers.get('content-type') || '';
  const ext = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' : 'wav';
  const path = join(GENERATED_DIR, `voice-${Date.now()}.${ext}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, voice };
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

async function makeFullPackage(bulletinPath) {
  const parts = [];
  const intro = join(ASSET_DIR, 'intro.wav');
  const outro = join(ASSET_DIR, 'outro.wav');
  if (existsSync(intro)) parts.push(intro);
  parts.push(bulletinPath);
  if (existsSync(outro)) parts.push(outro);

  const out = join(GENERATED_DIR, `news-package-${Date.now()}.wav`);
  if (parts.length === 1) {
    await copyFile(parts[0], out);
    return out;
  }

  const inputs = parts.flatMap((path) => ['-i', path]);
  const labels = parts.map((_, index) => `[${index}:a]`).join('');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', `${labels}concat=n=${parts.length}:v=0:a=1[out]`,
    '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

async function waitUntilMissing(path, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${basename(path)}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

async function queueAudio(path) {
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

    const snapshot = await subwaveSnapshot();
    const generated = await generateBulletinText(snapshot, config, candidates);
    const speech = await synthesizeVoice(snapshot, generated.text);
    const bulletin = await makeBulletinAudio(config, speech.path);
    const packagePath = await makeFullPackage(bulletin);
    await queueAudio(packagePath);

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
    await log(`Bulletin queued using ${generated.provider}/${generated.model}, ${speech.voice.engine}/${speech.voice.voice || 'default'}: ${generated.text}`);
    return { ok: true, spoken: generated.text };
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
        .filter((name) => /\.(wav|mp3)$/i.test(name))
        .sort()
        .reverse();
      await Promise.all(names.slice(24).map((name) => rm(join(GENERATED_DIR, name), { force: true })));
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

async function scheduleTick() {
  const config = await settings();
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
    due = parts.minute === 1;
  } else if (config.scheduleMode === 'before') {
    due = parts.minute === 59;
    slotHour = (parts.hour + 1) % 24;
  } else if (config.scheduleMode === 'custom') {
    due = parts.minute === config.customMinute;
  }

  const key = `${parts.year}-${parts.month}-${parts.day}-${slotHour}-${config.scheduleMode}`;
  if (due && key !== config.lastScheduleSlot) {
    await saveJson(SETTINGS_FILE, { ...config, lastScheduleSlot: key });
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
      signal: AbortSignal.timeout(10000),
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

function updaterContainer(command) {
  const name = `subwave-news-${command}-${Date.now()}`;
  const args = [
    'run', '-d', '--rm', '--name', name,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${EXTENSION_DIR}:${EXTENSION_DIR}`,
    '-v', `${SUBWAVE_DIR}:${SUBWAVE_DIR}`,
    '-v', `${HOST_STATE_DIR}:/var/sub-wave`,
    '-w', EXTENSION_DIR,
    '-e', `EXTENSION_DIR=${EXTENSION_DIR}`,
    '-e', `SUBWAVE_DIR=${SUBWAVE_DIR}`,
    '-e', 'SUBWAVE_STATE_DIR=/var/sub-wave',
    '-e', 'DATA_DIR=/var/sub-wave/extensions/hourly-news',
    '-e', `SUBWAVE_NETWORK=${SUBWAVE_NETWORK}`,
    '-e', `MANAGER_PORT=${MANAGER_PORT}`,
    MANAGER_IMAGE,
    'bash', './manage.sh', command,
  ];
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || 'Could not start updater').trim());
  return result.stdout.trim();
}

async function rescanSkill() {
  await controllerRequest('/dj/skills/rescan', { method: 'POST' });
}

let proxyRefreshBusy = false;
async function refreshProxyRoute(force = false) {
  if (proxyRefreshBusy || !existsSync(PROXY_REFRESH_SCRIPT)) return { ok: false, skipped: true };
  proxyRefreshBusy = true;
  try {
    const args = [PROXY_REFRESH_SCRIPT];
    if (force) args.push('--force');
    const result = spawnSync('bash', args, {
      encoding: 'utf8',
      env: {
        ...process.env,
        EXTENSION_DIR,
        SUBWAVE_DIR,
        SUBWAVE_NETWORK,
      },
    });
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'proxy refresh failed').trim());
    }
    const message = (result.stdout || '').trim();
    if (message) await log(message);
    return { ok: true, message };
  } catch (error) {
    await log(`Proxy refresh warning: ${error.message}`);
    return { ok: false, error: error.message };
  } finally {
    proxyRefreshBusy = false;
  }
}

// SUB/WAVE's Caddy image can change independently of this companion. Rebuild
// the generated overlay from the new image automatically, then hot-reload Caddy.
setInterval(() => {
  refreshProxyRoute(false).catch(() => {});
}, 5 * 60 * 1000);

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
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
  if (!['intro', 'bed', 'outro'].includes(req.params.type)) return res.status(400).send('Unknown asset.');
  const path = join(ASSET_DIR, `${req.params.type}.wav`);
  if (!existsSync(path)) return res.status(404).send('No audio uploaded.');
  res.type('audio/wav').sendFile(path);
});

app.delete('/api/assets/:type', async (req, res) => {
  if (!['intro', 'bed', 'outro'].includes(req.params.type)) return res.status(400).json({ error: 'Unknown asset.' });
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
  let subwave = { connected: false, error: null, persona: null, llm: null, tts: null };
  try {
    const snapshot = await subwaveSnapshot();
    const llm = snapshot.values?.llm || snapshot.raw?.llm || {};
    const voice = resolveVoice(snapshot);
    subwave = {
      connected: true,
      error: null,
      persona: snapshot.persona?.name || null,
      llm: `${llm.provider || '?'} / ${llm.model || '?'}`,
      tts: `${voice.engine} / ${voice.voice || 'default'}`,
    };
  } catch (error) {
    subwave.error = error.message;
  }
  res.json({
    manager: 'running',
    busy: runBusy,
    lastRunAt: config.lastRunAt,
    lastRunStatus: config.lastRunStatus,
    subwave,
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

app.post('/api/proxy/refresh', async (_req, res) => {
  const result = await refreshProxyRoute(true);
  if (!result.ok) return res.status(500).json({ error: result.error || 'Proxy refresh failed.' });
  res.json({ ok: true, message: result.message || 'Proxy route refreshed.' });
});

app.post('/api/update', (_req, res) => {
  try {
    updaterContainer('update-worker');
    res.json({ ok: true, message: 'Update started. The page may disconnect briefly while the manager restarts.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rollback', (_req, res) => {
  try {
    updaterContainer('rollback-worker');
    res.json({ ok: true, message: 'Rollback started. The page may disconnect briefly while the manager restarts.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  log(`Hourly News Manager listening internally on port ${PORT}; public path is /news-bulletin/. No SUB/WAVE source files are modified.`).catch(() => {});
  rescanSkill().catch((error) => log(`Skill rescan warning: ${error.message}`));
  refreshProxyRoute(false).catch(() => {});
});
