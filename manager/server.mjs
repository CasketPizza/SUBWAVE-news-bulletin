import express from 'express';
import multer from 'multer';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';
import {
  mkdir, readFile, writeFile, rename, rm, readdir, copyFile, stat,
} from 'node:fs/promises';
import fs, { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
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
const HEADLINES_CACHE_FILE = join(DATA_DIR, 'headlines-cache.json');
const INTEREST_ARTICLES_CACHE_FILE = join(DATA_DIR, 'interest-articles-cache.json');
const INTERESTS_FILE = join(DATA_DIR, 'interests.json');
const HELD_QUEUE_FILE = join(DATA_DIR, 'held-queue.json');
const LOG_FILE = join(DATA_DIR, 'manager.log');
const ASSET_META_FILE = join(DATA_DIR, 'assets.json');
const SAY_FILE = join(STATE_DIR, 'say.txt');
const NOW_PLAYING_FILE = join(STATE_DIR, 'now-playing.json');
const SKILL_FILE = join(STATE_DIR, 'skills/hourly-news-bulletin/SKILL.md');
const RAW_SUBWAVE_SETTINGS = join(STATE_DIR, 'settings.json');
const SUBWAVE_SECRETS = join(STATE_DIR, 'secrets.env');
const GITHUB_REPO = process.env.GITHUB_REPO || 'CasketPizza/SUBWAVE-news-bulletin';
const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || 'broadcast';
const LIQUIDSOAP_PORT = Number(process.env.LIQUIDSOAP_PORT || 1234);
const PUBLIC_DIR = join(import.meta.dirname, 'public');
const INDEX_TEMPLATE_FILE = join(PUBLIC_DIR, 'index.html');
let APP_VERSION = 'dev';
try {
  APP_VERSION = (await readFile(join(EXTENSION_DIR, 'VERSION'), 'utf8')).trim() || 'dev';
} catch {}

const LOG_MAX_BYTES = Math.min(1024 * 1024, Math.max(32 * 1024, Number(process.env.LOG_MAX_BYTES) || 128 * 1024));
const LOG_TAIL_BYTES = Math.min(LOG_MAX_BYTES, Math.max(16 * 1024, Number(process.env.LOG_TAIL_BYTES) || 64 * 1024));
const LOG_MAX_LINES = Math.min(500, Math.max(25, Number(process.env.LOG_MAX_LINES) || 120));
const FFMPEG_TIMEOUT_MS = Math.min(10 * 60 * 1000, Math.max(30 * 1000, Number(process.env.FFMPEG_TIMEOUT_MS) || 3 * 60 * 1000));
const FFPROBE_TIMEOUT_MS = Math.min(2 * 60 * 1000, Math.max(5 * 1000, Number(process.env.FFPROBE_TIMEOUT_MS) || 30 * 1000));
// SUB/WAVE's admin TTS preview endpoint intentionally keeps only the first 200
// input characters. The companion therefore renders longer on-air copy in
// complete, bounded chunks below that ceiling and joins the audio back together.
const TTS_PREVIEW_SAFE_CHARS = 180;
const TTS_CHUNK_PAUSE_SECONDS = 0.10;

const INTEREST_DEFAULTS = {
  profile: '',
  likes: [],
  dislikes: [],
  updatedAt: null,
  generatedAt: null,
};

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
  storyPauseSeconds: 2.25,
  interruptCurrentTrack: true,

  // Newsroom prompt controls. These are intentionally separate so an operator
  // can change what gets selected, how source material is interpreted, and how
  // the finished bulletin sounds without editing SUB/WAVE's skill file.
  storySelectionInstructions: `Choose the most consequential and genuinely new stories. Prioritise Australian national and local-interest news, then major world developments. Avoid filling the bulletin with several minor stories about the same topic.`,
  articleHandlingInstructions: `Treat each supplied headline and RSS summary as source material, not as wording to copy. Paraphrase accurately, preserve uncertainty and attribution, and never add facts that are not present. Do not merge separate reports into one event. Mention a publication only when attribution materially improves clarity.`,
  deliveryInstructions: `Sound like a composed radio newsreader. Use complete natural sentences and an even pace. Begin directly, avoid a long greeting, and finish cleanly without teasing music or saying that links are available. Treat every story as a clearly separate item: finish one story cleanly before beginning the next, and never use a transition that makes unrelated reports sound connected.`,

  // Presenter and voice routing. presenterMode=persona selects a dedicated
  // SUB/WAVE persona for both style and, by default, voice. voiceMode=override
  // keeps that presenter's writing style but renders through any configured
  // engine/voice combination.
  presenterMode: 'on-air',
  presenterPersonaId: '',
  voiceMode: 'presenter',
  voiceEngine: 'piper',
  voiceName: '',
  voiceCloudProvider: 'openai',
  voiceSpeed: 1,
  voiceLanguage: '',

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
  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).send('Authentication required');
}

function preventAdminCaching(_req, res, next) {
  // The manager is an authenticated administration page that changes between
  // releases. Never let a stale HTML/JS/auth response survive a reinstall or
  // container recreation.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

function renderedIndex() {
  const template = fs.readFileSync(INDEX_TEMPLATE_FILE, 'utf8');
  return template.replaceAll('__APP_VERSION__', encodeURIComponent(APP_VERSION));
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
  const loaded = { ...DEFAULTS, ...(await loadJson(SETTINGS_FILE, DEFAULTS)) };
  // Removed in v0.5.14. Do not carry the old field forward when an existing
  // settings.json is loaded and later saved.
  delete loaded.maxLengthSeconds;
  return loaded;
}

function cleanInterestProfile(value) {
  return String(value || '')
    .replace(/<\/?(?:think|analysis|reasoning)\b[^>]*>/gi, ' ')
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^(?:audience )?interest profile\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1600);
}

function cleanInterestExample(value) {
  const item = value && typeof value === 'object' ? value : {};
  const title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!title) return null;
  const source = String(item.source || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const summary = String(item.summary || item.description || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
  const link = safeWebUrl(String(item.link || '').trim()).slice(0, 2000);
  const published = String(item.published || '').trim().slice(0, 120);
  const key = String(item.key || hash(`${source}|${title}`)).slice(0, 128);
  return { key, title, source, summary, link, published, selectedAt: item.selectedAt || new Date().toISOString() };
}

async function interests() {
  const raw = await loadJson(INTERESTS_FILE, INTEREST_DEFAULTS);
  return {
    ...INTEREST_DEFAULTS,
    profile: cleanInterestProfile(raw.profile),
    likes: (Array.isArray(raw.likes) ? raw.likes : []).map(cleanInterestExample).filter(Boolean).slice(-50),
    dislikes: (Array.isArray(raw.dislikes) ? raw.dislikes : []).map(cleanInterestExample).filter(Boolean).slice(-50),
    updatedAt: raw.updatedAt || null,
    generatedAt: raw.generatedAt || null,
  };
}

function publicInterests(value) {
  return {
    profile: value.profile || '',
    likeCount: value.likes?.length || 0,
    dislikeCount: value.dislikes?.length || 0,
    updatedAt: value.updatedAt || null,
    generatedAt: value.generatedAt || null,
  };
}

const ASSET_TYPES = ['intro', 'bed', 'outro'];

async function assetMetadata() {
  const value = await loadJson(ASSET_META_FILE, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function assetSnapshot() {
  const metadata = await assetMetadata();
  const result = {};
  for (const type of ASSET_TYPES) {
    const uploaded = existsSync(join(ASSET_DIR, `${type}.wav`));
    result[type] = uploaded ? {
      uploaded: true,
      fileName: String(metadata[type]?.fileName || `${type}.wav`).slice(0, 255),
      uploadedAt: metadata[type]?.uploadedAt || null,
    } : null;
  }
  return result;
}

function cleanInstruction(value, fallback) {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, 6000);
}

function cleanSettings(body) {
  const input = body && typeof body === 'object' ? body : {};
  const mode = ['after', 'before', 'custom', 'manual'].includes(input.scheduleMode)
    ? input.scheduleMode : 'after';
  const presenterMode = input.presenterMode === 'persona' ? 'persona' : 'on-air';
  const voiceMode = input.voiceMode === 'override' ? 'override' : 'presenter';
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
    storyPauseSeconds: Math.min(6, Math.max(0.5, Number(input.storyPauseSeconds) || DEFAULTS.storyPauseSeconds)),
    interruptCurrentTrack: input.interruptCurrentTrack !== false,
    storySelectionInstructions: cleanInstruction(
      input.storySelectionInstructions,
      DEFAULTS.storySelectionInstructions,
    ),
    articleHandlingInstructions: cleanInstruction(
      input.articleHandlingInstructions,
      DEFAULTS.articleHandlingInstructions,
    ),
    deliveryInstructions: cleanInstruction(
      input.deliveryInstructions,
      DEFAULTS.deliveryInstructions,
    ),
    presenterMode,
    presenterPersonaId: String(input.presenterPersonaId || '').trim().slice(0, 200),
    voiceMode,
    voiceEngine: String(input.voiceEngine || DEFAULTS.voiceEngine).trim().slice(0, 64) || DEFAULTS.voiceEngine,
    voiceName: String(input.voiceName || '').trim().slice(0, 300),
    voiceCloudProvider: String(input.voiceCloudProvider || DEFAULTS.voiceCloudProvider).trim().slice(0, 64) || DEFAULTS.voiceCloudProvider,
    voiceSpeed: Math.min(2, Math.max(0.5, Number(input.voiceSpeed) || 1)),
    voiceLanguage: String(input.voiceLanguage || '').trim().slice(0, 100),
    bedVolumeDb: Math.min(0, Math.max(-40, Number(input.bedVolumeDb) || -18)),
    bedFadeIn: Math.min(10, Math.max(0, Number(input.bedFadeIn) || 0)),
    bedFadeOut: Math.min(10, Math.max(0, Number(input.bedFadeOut) || 0)),
    loopBed: input.loopBed !== false,
    lastRunAt: input.lastRunAt || null,
    lastRunStatus: input.lastRunStatus || null,
    lastScheduleSlot: input.lastScheduleSlot || null,
  };
}

let logMaintenance = Promise.resolve();

async function readTail(path, maxBytes = LOG_TAIL_BYTES, maxLines = LOG_MAX_LINES) {
  let handle;
  try {
    const info = await stat(path);
    if (!info.size) return '';
    const length = Math.min(info.size, maxBytes);
    const start = Math.max(0, info.size - length);
    handle = await fs.promises.open(path, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.replace(/^[^\n]*(?:\n|$)/, '');
    return text.split(/\r?\n/).filter(Boolean).slice(-maxLines).join('\n');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function compactLogIfNeeded() {
  try {
    const info = await stat(LOG_FILE);
    if (info.size <= LOG_MAX_BYTES) return;
    const recent = await readTail(LOG_FILE, LOG_TAIL_BYTES, LOG_MAX_LINES);
    await writeFile(LOG_FILE, recent ? `${recent}\n` : '');
  } catch (error) {
    if (error?.code !== 'ENOENT') process.stderr.write(`Could not compact bulletin log: ${error.message}\n`);
  }
}

async function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  await writeFile(LOG_FILE, line, { flag: 'a' }).catch(() => {});
  logMaintenance = logMaintenance.then(compactLogIfNeeded, compactLogIfNeeded);
  await logMaintenance;
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

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®',
  };
  return String(value || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanFeedText(value) {
  return decodeHtmlEntities(textValue(value))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|h[1-6]|blockquote|section|article)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(?:…|\.\.\.)\]\s*$/u, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function completeSummary(value, maxChars = 1200) {
  const cleaned = cleanFeedText(value)
    .replace(/\s+(?:read|continue) more\s*(?:…|\.\.\.)?\s*$/i, '')
    .trim();
  if (!cleaned) return '';

  const clipped = cleaned.length > maxChars ? cleaned.slice(0, maxChars + 1) : cleaned;
  const visiblyTruncated = cleaned.length > maxChars || /(?:…|\.\.\.|\[more\])\s*$/i.test(cleaned);
  const endsCleanly = /[.!?][\])}"'’”]*$/.test(clipped);
  if (!visiblyTruncated && endsCleanly) return clipped;

  const limit = Math.min(maxChars, clipped.length);
  const candidate = clipped.slice(0, limit);
  let lastEnd = -1;
  const sentenceEnd = /[.!?][\])}"'’”]*(?=\s|$)/g;
  for (const match of candidate.matchAll(sentenceEnd)) lastEnd = match.index + match[0].length;

  // Never hand the LLM or user a sentence chopped halfway through. If the feed
  // supplies only an incomplete teaser and no complete sentence, omit the
  // summary and fall back to the complete headline instead.
  if (lastEnd < 20 || lastEnd < candidate.length * 0.20) return '';
  return candidate.slice(0, lastEnd).trim();
}

function safeWebUrl(value, base = undefined) {
  try {
    const url = new URL(String(value || '').trim(), base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function normaliseArticleItem(item) {
  const title = cleanFeedText(item?.title).slice(0, 500);
  const summary = completeSummary(item?.summary || item?.description || '', 1200);
  const source = cleanFeedText(item?.source).slice(0, 120);
  return {
    ...item,
    source,
    title,
    summary,
    description: summary,
    summaryComplete: Boolean(summary),
    link: safeWebUrl(item?.link),
    published: String(item?.published || '').trim().slice(0, 120),
  };
}

function summaryCandidates(item) {
  // Prefer fields intended as summaries and choose the richest complete one.
  // Full feed content is only a fallback when no complete summary/description
  // is available.
  const summaries = [
    item?.summary, item?.description, item?.['media:description'], item?.subtitle,
  ].map((value) => completeSummary(value)).filter(Boolean).sort((a, b) => b.length - a.length);
  if (summaries.length) return summaries;
  return [item?.['content:encoded'], item?.content]
    .map((value) => completeSummary(value)).filter(Boolean);
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
    const link = safeWebUrl(typeof item.link === 'object'
      ? item.link?.['@_href'] || textValue(item.link)
      : textValue(item.link), feed.url);
    const summary = summaryCandidates(item)[0] || '';
    return {
      source: feed.name || new URL(feed.url).hostname.replace(/^www\./, ''),
      title: cleanFeedText(item.title).slice(0, 500),
      summary,
      // Keep the old field for cached-data and release compatibility.
      description: summary,
      summaryComplete: Boolean(summary),
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
        'User-Agent': 'SUBWAVE-News-Bulletin/0.5.12 (+https://github.com/CasketPizza/SUBWAVE-news-bulletin)',
      },
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return parseFeed(await response.text(), feed).slice(0, maxItems);
  } finally {
    clearTimeout(timer);
  }
}

function mergeHeadlineBuckets(buckets, limit) {
  const local = new Set();
  const merged = [];
  for (let row = 0; merged.length < limit; row++) {
    let found = false;
    for (const bucket of buckets) {
      const item = bucket[row];
      if (!item) continue;
      found = true;
      const key = hash(item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
      if (!key || local.has(key)) continue;
      local.add(key);
      merged.push({ ...item, key });
    }
    if (!found) break;
  }
  return merged;
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

  let current = [];
  let freshness = 'fresh';
  if (buckets.length) {
    current = mergeHeadlineBuckets(buckets, config.maxCandidates * 3);
    await saveJson(HEADLINES_CACHE_FILE, {
      items: current,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  } else {
    const cached = await loadJson(HEADLINES_CACHE_FILE, { items: [], updatedAt: null });
    current = Array.isArray(cached.items) ? cached.items.map(normaliseArticleItem).filter((item) => item.title) : [];
    freshness = 'cached';
    if (!current.length) throw new Error('All configured news feeds failed and no previous headline cache is available.');
    await log(`Using cached headlines from ${cached.updatedAt || 'an earlier successful fetch'}.`);
  }

  if (!current.length) throw new Error('The configured feeds returned no stories.');

  const seenLedger = await loadJson(SEEN_FILE, { keys: [] });
  const old = new Set(Array.isArray(seenLedger.keys) ? seenLedger.keys : []);
  const fresh = current.filter((item) => !old.has(item.key));
  let candidates;
  if (fresh.length) {
    candidates = fresh.slice(0, config.maxCandidates);
  } else {
    candidates = current.slice(0, config.maxCandidates);
    if (freshness !== 'cached') freshness = 'recap';
  }

  return { candidates, ledger: old, freshness };
}

async function settleWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = { status: 'fulfilled', value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function collectInterestArticles(config) {
  // Keep a deeper pool than the normal bulletin candidate list so the tuner can
  // reveal more examples in small batches without refetching every time the
  // operator reaches the bottom of the popup.
  const perFeed = Math.min(30, Math.max(16, (Number(config.maxItemsPerFeed) || 8) * 2));
  // The preference browser is interactive rather than time-critical. Limit feed
  // concurrency so opening the popup cannot cause a network/CPU burst on a
  // small SUB/WAVE VM when many sources are configured.
  const settled = await settleWithConcurrency(config.feeds, 4, (feed) => fetchFeed(feed, perFeed));
  const buckets = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.length) buckets.push(result.value);
    else if (result.status === 'rejected') {
      void log(`Interest browser feed failed: ${config.feeds[index].name || config.feeds[index].url}: ${result.reason?.message || result.reason}`);
    }
  });

  if (buckets.length) {
    const items = mergeHeadlineBuckets(buckets, 120);
    const payload = { items, updatedAt: new Date().toISOString(), cached: false };
    await saveJson(INTEREST_ARTICLES_CACHE_FILE, payload).catch(() => {});
    return payload;
  }

  const cached = await loadJson(INTEREST_ARTICLES_CACHE_FILE, { items: [], updatedAt: null });
  const items = Array.isArray(cached.items)
    ? cached.items.map(normaliseArticleItem).filter((item) => item.title).slice(0, 120)
    : [];
  if (!items.length) throw new Error('The configured feeds returned no articles and no interest-browser cache is available.');
  return { items, updatedAt: cached.updatedAt || null, cached: true };
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
  const fallbackPersona = {
    id: '',
    name: 'SUB/WAVE DJ', tagline: '', soul: '', humour: 5, localColour: 5, warmth: 5,
    language: 'English', tts: {},
  };
  const onAirPersona = personas.find((item) => item?.id === activeId) || personas[0] || fallbackPersona;
  return { api, raw, values, personas, onAirPersona, persona: onAirPersona };
}

function resolvePresenter(snapshot, config) {
  if (config.presenterMode === 'persona' && config.presenterPersonaId) {
    const selected = snapshot.personas?.find((item) => item?.id === config.presenterPersonaId);
    if (selected) return selected;
  }
  return snapshot.onAirPersona || snapshot.persona;
}

function uniqueVoiceOptions(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const id = String(typeof value === 'string' ? value : value?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: String(typeof value === 'string' ? value : value?.label || id),
    });
  }
  return out;
}

function subwaveOptions(snapshot) {
  const meta = snapshot.api?.tts || {};
  const stationTts = snapshot.values?.tts || {};
  const voices = {
    piper: [...(meta.piperVoices || [])],
    kokoro: [...(meta.kokoroVoices || [])],
    chatterbox: [...(meta.chatterboxVoices || [])],
    'pocket-tts': [...(meta.pocketTtsVoices || []), ...(meta.pocketTtsCustomVoices || [])],
    cloud: [],
    remote: [],
  };

  for (const persona of snapshot.personas || []) {
    const tts = persona?.tts || {};
    if (tts.engine && tts.voice && voices[tts.engine]) voices[tts.engine].push(tts.voice);
  }
  if (stationTts.cloud?.voice) voices.cloud.push(stationTts.cloud.voice);
  if (stationTts.kokoro?.voice) voices.kokoro.push(stationTts.kokoro.voice);
  if (stationTts.chatterbox?.referenceVoice) voices.chatterbox.push(stationTts.chatterbox.referenceVoice);
  if (stationTts.pocketTts?.voice) voices['pocket-tts'].push(stationTts.pocketTts.voice);

  for (const engine of Object.keys(voices)) voices[engine] = uniqueVoiceOptions(voices[engine]);

  const configuredEngines = Array.isArray(meta.engines) ? meta.engines : [];
  const engines = [...new Set([
    ...configuredEngines,
    'piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote',
  ])];

  return {
    onAirPersonaId: snapshot.onAirPersona?.id || '',
    personas: (snapshot.personas || []).map((persona) => ({
      id: String(persona?.id || ''),
      name: String(persona?.name || 'Unnamed persona'),
      tagline: String(persona?.tagline || ''),
      language: String(persona?.language || 'English'),
      tts: persona?.tts || {},
    })).filter((persona) => persona.id),
    engines,
    availableEngines: meta.available || {},
    voices,
    cloudProviders: Array.isArray(meta.cloudProviders) ? meta.cloudProviders : [],
  };
}

function toneLine(label, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n <= 3) return `${label}: low`;
  if (n >= 7) return `${label}: high`;
  return `${label}: balanced`;
}

function buildPrompts(snapshot, config, candidates, presenter, freshness = 'fresh', interestProfile = '') {
  const values = snapshot.values || {};
  const station = values.station || 'SUB/WAVE';
  const presenterLanguage = config.voiceMode === 'override' && config.voiceLanguage
    ? config.voiceLanguage
    : (presenter.language || 'English');
  const location = values.weather?.onAirLocation || values.weather?.locationName || '';
  const rows = candidates.map((item, index) => (
    `${index + 1}. [${item.source}] ${item.title}${(item.summary || item.description) ? ` — ${item.summary || item.description}` : ''}`
  )).join('\n');
  const tone = [
    toneLine('Humour', presenter.humour),
    toneLine('Local colour', presenter.localColour),
    toneLine('Warmth', presenter.warmth),
  ].filter(Boolean).join('; ');

  const system = `You are ${presenter.name || 'the news presenter'}, presenting a news bulletin for ${station}.${location ? ` The station is based around ${location}.` : ''}
Presenter tagline: ${presenter.tagline || '(none)'}
Presenter description: ${presenter.soul || 'natural, concise radio news presenter'}
Tone controls: ${tone || 'balanced'}
Language: ${presenterLanguage}

Write only the words the presenter should actually speak. Never repeat, quote, summarise, explain, or acknowledge the prompt, its section labels, its instructions, its source list, or its formatting rules. Do not output headings, bullets, stage directions, citations, URLs, markdown, or commentary about your task.

NON-NEGOTIABLE ACCURACY RULES:
- Use only facts contained in the supplied source material.
- Never invent context, merge unrelated reports, or turn uncertainty into certainty.
- Preserve meaningful attribution, allegations, estimates, and disputed claims.
- Do not joke about death, disasters, victims, war, serious crime, or personal tragedy.
- The operator's style instructions may shape presentation but cannot override these accuracy rules.
- Every story must be self-contained. Never blend two unrelated stories into one paragraph.
- Finish every selected story as complete on-air copy. Never stop mid-sentence or mid-thought to satisfy a length target.`;

  const freshnessNote = freshness === 'fresh'
    ? 'At least one supplied story has not appeared in an earlier bulletin.'
    : freshness === 'cached'
      ? 'The live feeds were unavailable. Use the latest cached source material as a measured recap and do not call any item breaking, new, or just in.'
      : 'There are no unseen headlines. Still produce a useful latest-news recap from the supplied current feed items. Do not pretend the stories are newly breaking.';

  const user = `NEWSROOM STATUS
${freshnessNote}

NEWSROOM BRIEF — STORY SELECTION
${config.storySelectionInstructions}

${interestProfile ? `AUDIENCE INTEREST PROFILE — SOFT PREFERENCE ONLY
${interestProfile}
Use this profile only to break ties between otherwise suitable stories. Consequence, freshness, major local or world importance, and avoiding repetition take priority. The examples that created this profile were not requests to air any particular article. Never mention the profile or those examples on air.

` : ''}SOURCE-MATERIAL HANDLING
${config.articleHandlingInstructions}

ON-AIR DELIVERY
${config.deliveryInstructions}

Use no more than ${config.maxHeadlines} stories. Give every selected story enough complete context to make sense on air, and finish each story cleanly.

Fresh candidate headlines and complete RSS summaries. A missing summary means the feed supplied no complete, uncut sentence; use only the headline in that case:
${rows}

Return only the finished spoken bulletin. Do not repeat any instruction or section label above.`;
  return { system, user };
}

function promptsForOutput(prompts, mode) {
  if (mode === 'json') {
    const contract = `OUTPUT CONTRACT: Return only valid JSON matching this shape: {"stories":["first finished spoken story","second finished spoken story"]}. Each array item must contain only words to be spoken on air. Do not include prompt text, instructions, labels, analysis, source lists, markdown, control markers, or extra keys.`;
    return {
      system: `${prompts.system}

${contract}`,
      user: `${prompts.user}

${contract}`,
    };
  }
  const contract = 'OUTPUT CONTRACT: Return only the finished spoken bulletin. Put [[STORY_BREAK]] on its own line between stories. The marker is not spoken. Include no other labels or formatting.';
  return {
    system: `${prompts.system}

${contract}`,
    user: `${prompts.user}

${contract}`,
  };
}

function bulletinJsonSchema(maxStories) {
  return {
    type: 'object',
    properties: {
      stories: {
        type: 'array',
        minItems: 1,
        maxItems: Math.max(1, Number(maxStories) || 1),
        items: {
          type: 'string',
          minLength: 1,
          description: 'Finished words spoken by the radio presenter only. No analysis, planning, reasoning, instructions, labels, or hidden-thought tags.',
        },
      },
    },
    required: ['stories'],
    additionalProperties: false,
  };
}

function secret(name) {
  return process.env[name] || stateSecrets[name] || '';
}

function stripReasoningBlocks(value) {
  let text = String(value || '');
  // Some community GGUF chat templates ignore Ollama's `think:false` switch
  // and put hidden reasoning directly in message.content. Remove only explicit
  // reasoning containers here; untagged planning is rejected by the validator
  // below rather than guessed away and accidentally broadcast.
  for (const tag of ['think', 'analysis', 'reasoning']) {
    text = text.replace(new RegExp(String.raw`<${tag}\b[^>]*>[\s\S]*?<\/${tag}>`, 'gi'), ' ');
  }
  return text
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function trimOutput(value) {
  return stripReasoningBlocks(value)
    .replace(/^(?:script|bulletin|news bulletin|final answer)\s*:\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function parseStoryJson(value) {
  const text = stripReasoningBlocks(value);
  const accept = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed?.stories) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = accept(text);
  if (direct) return direct;

  // A model may emit untagged planning before the JSON despite structured
  // output. Extract a balanced JSON object containing `stories` instead of
  // passing the planning prose to TTS when the direct parse fails.
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const parsed = accept(text.slice(start, index + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function splitBulletinStories(value, maxStories) {
  const cleaned = trimOutput(value)
    .replace(/\r/g, '')
    .replace(/^[ \t]*(?:story|headline)\s*\d+\s*[:.-]\s*/gim, '')
    .trim();
  let parts = cleaned.split(/\n\s*\[\[STORY_BREAK\]\]\s*\n|\[\[STORY_BREAK\]\]/i);
  if (parts.length === 1) parts = cleaned.split(/\n\s*\n+/);
  parts = parts
    .map((part) => part.replace(/^[\s•*-]+|[\s]+$/g, '').trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxStories));
  return parts.length ? parts : [cleaned].filter(Boolean);
}

function normalizeForLeakCheck(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function unsafeOutputReason(stories, config, interestProfile = '') {
  const text = stories.join('\n');
  const fixedPatterns = [
    /newsroom status/i,
    /newsroom brief/i,
    /source[- ]material handling/i,
    /on-air delivery/i,
    /fresh candidate headlines/i,
    /non-negotiable accuracy rules/i,
    /output contract/i,
    /return only (?:the )?finished spoken bulletin/i,
    /use no more than \d+ stories/i,
    /presenter (?:tagline|description)/i,
    /tone controls:/i,
    /the (?:user|system) prompt/i,
    /as an ai(?: language model)?/i,
    /<\/?(?:think|analysis|reasoning)\b/i,
    /(?:^|\n)\s*(?:analysis|reasoning|thought process|thinking)\s*:/i,
    /\b(?:json schema|stories array|internal reasoning|chain of thought)\b/i,
    /\b(?:the prompt|these instructions|the source list|the requested format)\b/i,
  ];
  const fixed = fixedPatterns.find((pattern) => pattern.test(text));
  if (fixed) return `matched ${fixed}`;

  // Finished copy should begin like copy, not like a model planning its answer.
  // Keep this check anchored to the opening so ordinary quoted phrases such as
  // “we need to act” inside a real news story are not rejected.
  for (const story of stories) {
    const opening = normalizeForLeakCheck(story).slice(0, 360);
    if (/^(?:okay[,.!?: -]*|alright[,.!?: -]*)?(?:let(?:'s| us) (?:think|analy[sz]e|craft|write|prepare|construct|select)|we (?:need|should|must|have) to|i (?:need|should|must|will|have) to|need to (?:write|craft|produce|select|ensure)|the (?:user|task|prompt) (?:asks|wants|requires|is)|given (?:the|this) prompt|first[, ]+(?:i|we) (?:need|should|will)|to answer this|my approach|here(?:'s| is) (?:the|my) reasoning)\b/i.test(opening)) {
      return 'began with model planning or reasoning';
    }
  }

  const spoken = normalizeForLeakCheck(text);
  for (const instruction of [
    config.storySelectionInstructions,
    config.articleHandlingInstructions,
    config.deliveryInstructions,
    interestProfile,
  ]) {
    const normalized = normalizeForLeakCheck(instruction);
    if (normalized.length >= 70 && spoken.includes(normalized.slice(0, 70))) {
      return 'repeated an editable newsroom instruction';
    }
  }
  return '';
}

function storiesFromGeneration(generated, maxStories) {
  if (Array.isArray(generated?.stories)) {
    return generated.stories
      .map((story) => trimOutput(story).replace(/\[\[STORY_BREAK\]\]/gi, '').trim())
      .filter(Boolean)
      .slice(0, Math.max(1, maxStories));
  }
  return splitBulletinStories(generated?.text || '', maxStories);
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

async function generateWithLeg(leg, rawLlm, prompts, config) {
  const provider = String(leg?.provider || '').trim();
  const model = String(leg?.model || '').trim();
  if (!provider || !model) throw new Error('SUB/WAVE has no LLM provider/model configured.');
  const maxTokens = Math.max(256, Math.min(2048, Number(rawLlm?.maxOutputTokens) || 900));

  if (provider === 'ollama') {
    const base = String(leg.ollamaUrl || rawLlm.ollamaUrl || 'http://host.docker.internal:11434').replace(/\/$/, '');
    const outputPrompts = promptsForOutput(prompts, 'json');
    const body = await fetchJson(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // Qwen 3 enables thinking by default in Ollama. A radio bulletin needs a
        // concise final script, not a long hidden reasoning pass, so disable it.
        think: false,
        // Keep the shared station model warm across the next hourly bulletin.
        keep_alive: '75m',
        format: bulletinJsonSchema(config.maxHeadlines),
        messages: [
          { role: 'system', content: outputPrompts.system },
          // `/no_think` is included as a second guard for community Qwen GGUF
          // templates that do not honour Ollama's top-level `think:false` flag.
          { role: 'user', content: `${outputPrompts.user}\n\n/no_think` },
        ],
        options: {
          num_ctx: Number(leg.numCtx || rawLlm.numCtx) || undefined,
          repeat_penalty: Number(leg.repeatPenalty || rawLlm.repeatPenalty) || undefined,
          temperature: 0.15,
          // Honour SUB/WAVE's configured output budget. The old 600-token clamp
          // acted as a second, hidden bulletin-length limit after the spoken-time
          // control was removed. The provider budget remains bounded above.
          num_predict: maxTokens,
        },
      }),
    }, 180000);
    const hiddenThinking = String(body?.message?.thinking || '').trim();
    if (hiddenThinking) {
      await log(`Ollama returned ${hiddenThinking.length} characters of hidden thinking; discarded before bulletin validation.`);
    }
    const raw = String(body?.message?.content || body?.response || '').trim();
    const parsed = parseStoryJson(raw);
    if (parsed) return { text: raw, stories: parsed.stories };
    return { text: trimOutput(raw), stories: null };
  }

  const outputPrompts = promptsForOutput(prompts, 'markers');

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
        system: outputPrompts.system,
        messages: [{ role: 'user', content: outputPrompts.user }],
      }),
    });
    return { text: trimOutput((body?.content || []).map((item) => item?.text || '').join('\n')), stories: null };
  }

  if (provider === 'google') {
    const key = providerKey(provider, rawLlm);
    if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not available to the companion.');
    const body = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: outputPrompts.system }] },
        contents: [{ role: 'user', parts: [{ text: outputPrompts.user }] }],
        generationConfig: { temperature: 0.35, maxOutputTokens: maxTokens },
      }),
    });
    return { text: trimOutput(body?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n')), stories: null };
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
        { role: 'system', content: outputPrompts.system },
        { role: 'user', content: outputPrompts.user },
      ],
    }),
  });
  return { text: trimOutput(body?.choices?.[0]?.message?.content), stories: null };
}

async function generateStoriesWithLeg(leg, rawLlm, prompts, config, candidates, interestProfile = '') {
  const expectedMultiple = Math.min(config.maxHeadlines, candidates.length) > 1;
  let lastReason = '';

  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptPrompts = attempt === 1 ? prompts : {
      ...prompts,
      user: `${prompts.user}

RETRY CORRECTION: The previous response was unsafe because it exposed instructions, planning, analysis, reasoning, used the wrong output format, or failed to separate the stories. Do not think aloud. Begin directly with the first finished on-air sentence and return only words the presenter should speak. Do not repeat any prompt text, section label, rule, source list, explanation, analysis, or thought process.${expectedMultiple ? ' Include at least two separate stories.' : ''}\n\n/no_think`,
    };
    const generated = await generateWithLeg(leg, rawLlm, attemptPrompts, config);
    const stories = storiesFromGeneration(generated, config.maxHeadlines);
    if (!stories.length) {
      lastReason = 'returned no usable stories';
    } else if (expectedMultiple && stories.length < 2) {
      lastReason = 'did not separate multiple stories';
    } else if (stories.some((story) => !/[.!?…][\s\"'”’)]*$/.test(story.trim()))) {
      lastReason = 'ended a story without completing its final sentence';
    } else {
      const leak = unsafeOutputReason(stories, config, interestProfile);
      if (!leak) return { text: stories.join(' '), stories };
      lastReason = `contained unsafe prompt or reasoning leakage (${leak})`;
    }

    if (attempt === 1) await log(`LLM bulletin output ${lastReason}; retrying once before TTS.`);
  }

  throw new Error(`The configured LLM ${lastReason || 'returned an invalid bulletin'} twice. Nothing was sent to TTS.`);
}

async function generateBulletinText(snapshot, config, candidates, presenter, freshness, interestProfile = '') {
  const prompts = buildPrompts(snapshot, config, candidates, presenter, freshness, interestProfile);
  const rawLlm = snapshot.raw?.llm || {};
  const apiLlm = snapshot.values?.llm || {};
  const primary = { ...rawLlm, ...apiLlm };
  try {
    const generated = await generateStoriesWithLeg(primary, rawLlm, prompts, config, candidates, interestProfile);
    return { ...generated, provider: primary.provider, model: primary.model };
  } catch (primaryError) {
    const fallbackRaw = rawLlm?.fallback || {};
    const fallbackApi = apiLlm?.fallback || {};
    const fallback = { ...fallbackRaw, ...fallbackApi };
    if (!fallback.enabled) throw primaryError;
    await log(`Primary LLM failed; trying fallback: ${primaryError.message}`);
    const generated = await generateStoriesWithLeg(fallback, rawLlm, prompts, config, candidates, interestProfile);
    return { ...generated, provider: fallback.provider, model: fallback.model };
  }
}


function interestProfileJsonSchema() {
  return {
    type: 'object',
    properties: {
      profile: {
        type: 'string',
        minLength: 1,
        maxLength: 1600,
        description: 'A concise, durable audience news-interest profile. No analysis, headings, article list, or mention of clicking examples.',
      },
    },
    required: ['profile'],
    additionalProperties: false,
  };
}

function parseInterestProfile(value) {
  const text = stripReasoningBlocks(value);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.profile === 'string') return cleanInterestProfile(parsed.profile);
  } catch {}
  const match = text.match(/\{[\s\S]*"profile"\s*:\s*"([\s\S]*?)"[\s\S]*\}/);
  if (match) {
    try { return cleanInterestProfile(JSON.parse(`"${match[1]}"`)); } catch {}
  }
  return cleanInterestProfile(text);
}

function interestProfilePrompts(likes, dislikes) {
  const format = (items) => items.slice(-25).map((item, index) => {
    const context = completeSummary(item.summary || item.description || '', 500);
    return `${index + 1}. [${item.source || 'Unknown source'}] ${item.title}${context ? ` — ${context}` : ''}`;
  }).join('\n') || '(none)';

  return {
    system: `You create a compact audience-interest profile for a radio news editor. Infer broad, durable topic and angle preferences from positive and negative example headlines. Do not request any specific example story, repeat a list of examples, infer private traits, or overfit to one named person or one-off event. Important, consequential and urgent news must always outrank taste preferences. Return only the profile text.`,
    user: `MORE LIKE THESE EXAMPLES
${format(likes)}

LESS LIKE THESE EXAMPLES
${format(dislikes)}

Write a useful preference profile in two to five complete sentences, no more than 900 characters. Describe favoured topics or angles and topics to de-emphasise. State that preferences are soft tie-breakers and cannot displace important news. Do not mention clicks, ratings, examples, this prompt, or individual article titles.`,
  };
}

async function generateInterestProfileWithLeg(leg, rawLlm, prompts) {
  const provider = String(leg?.provider || '').trim();
  const model = String(leg?.model || '').trim();
  if (!provider || !model) throw new Error('SUB/WAVE has no LLM provider/model configured.');
  const maxTokens = 500;

  if (provider === 'ollama') {
    const base = String(leg.ollamaUrl || rawLlm.ollamaUrl || 'http://host.docker.internal:11434').replace(/\/$/, '');
    const body = await fetchJson(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        keep_alive: '75m',
        format: interestProfileJsonSchema(),
        messages: [
          { role: 'system', content: prompts.system },
          { role: 'user', content: `${prompts.user}\n\n/no_think` },
        ],
        options: {
          num_ctx: Number(leg.numCtx || rawLlm.numCtx) || undefined,
          repeat_penalty: Number(leg.repeatPenalty || rawLlm.repeatPenalty) || undefined,
          temperature: 0.15,
          num_predict: maxTokens,
        },
      }),
    }, 180000);
    const profile = parseInterestProfile(body?.message?.content || body?.response || '');
    if (!profile) throw new Error('The LLM returned no usable interest profile.');
    return profile;
  }

  if (provider === 'anthropic') {
    const key = providerKey(provider, rawLlm);
    if (!key) throw new Error('ANTHROPIC_API_KEY is not available to the companion.');
    const body = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, system: prompts.system, messages: [{ role: 'user', content: prompts.user }] }),
    });
    return parseInterestProfile((body?.content || []).map((item) => item?.text || '').join('\n'));
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
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    });
    return parseInterestProfile(body?.candidates?.[0]?.content?.parts?.map((part) => part?.text || '').join('\n'));
  }

  let base = '';
  const key = providerKey(provider, rawLlm);
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
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: prompts.system }, { role: 'user', content: prompts.user }],
    }),
  });
  return parseInterestProfile(body?.choices?.[0]?.message?.content || '');
}

async function generateInterestProfile(snapshot, likes, dislikes) {
  const prompts = interestProfilePrompts(likes, dislikes);
  const rawLlm = snapshot.raw?.llm || {};
  const apiLlm = snapshot.values?.llm || {};
  const primary = { ...rawLlm, ...apiLlm };
  try {
    return await generateInterestProfileWithLeg(primary, rawLlm, prompts);
  } catch (primaryError) {
    const fallback = { ...(rawLlm?.fallback || {}), ...(apiLlm?.fallback || {}) };
    if (!fallback.enabled) throw primaryError;
    await log(`Primary LLM failed while generating interest profile; trying fallback: ${primaryError.message}`);
    return generateInterestProfileWithLeg(fallback, rawLlm, prompts);
  }
}

function mergeInterestSelections(current, selections, visibleKeys) {
  const visible = new Set((Array.isArray(visibleKeys) ? visibleKeys : []).map(String));
  const likes = new Map((current.likes || []).filter((item) => !visible.has(item.key)).map((item) => [item.key, item]));
  const dislikes = new Map((current.dislikes || []).filter((item) => !visible.has(item.key)).map((item) => [item.key, item]));

  for (const raw of Array.isArray(selections) ? selections : []) {
    const item = cleanInterestExample(raw);
    if (!item) continue;
    const rating = raw.rating === 'like' ? 'like' : raw.rating === 'dislike' ? 'dislike' : 'neutral';
    likes.delete(item.key);
    dislikes.delete(item.key);
    if (rating === 'like') likes.set(item.key, item);
    if (rating === 'dislike') dislikes.set(item.key, item);
  }

  const byNewest = (a, b) => String(a.selectedAt).localeCompare(String(b.selectedAt));
  return {
    likes: [...likes.values()].sort(byNewest).slice(-50),
    dislikes: [...dislikes.values()].sort(byNewest).slice(-50),
  };
}

function resolveVoice(snapshot, config, presenter = resolvePresenter(snapshot, config)) {
  const stationTts = snapshot.values?.tts || {};

  if (config.voiceMode === 'override') {
    const engine = config.voiceEngine || stationTts.defaultEngine || 'piper';
    return {
      engine,
      voice: config.voiceName || '',
      cloudProvider: config.voiceCloudProvider || stationTts.cloud?.provider || 'openai',
      speed: Math.min(2, Math.max(0.5, Number(config.voiceSpeed) || 1)),
      language: config.voiceLanguage || presenter?.language || 'English',
      voiceSettings: stationTts.cloud ? {
        voiceStability: stationTts.cloud.voiceStability,
        voiceStyle: stationTts.cloud.voiceStyle,
        voiceSimilarityBoost: stationTts.cloud.voiceSimilarityBoost,
        voiceUseSpeakerBoost: stationTts.cloud.voiceUseSpeakerBoost,
      } : undefined,
    };
  }

  const requested = presenter?.tts || {};
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
    language: presenter?.language || 'English',
    voiceSettings: stationTts.cloud ? {
      voiceStability: stationTts.cloud.voiceStability,
      voiceStyle: stationTts.cloud.voiceStyle,
      voiceSimilarityBoost: stationTts.cloud.voiceSimilarityBoost,
      voiceUseSpeakerBoost: stationTts.cloud.voiceUseSpeakerBoost,
    } : undefined,
  };
}

function speechBoundary(text, maxChars = TTS_PREVIEW_SAFE_CHARS) {
  const window = text.slice(0, maxChars + 1);
  const minimum = Math.min(72, Math.floor(maxChars * 0.4));
  const patterns = [
    /[.!?…][\"'”’)]?(?=\s|$)/g,
    /[;:](?=\s|$)/g,
    /[,—–](?=\s|$)/g,
  ];
  for (const pattern of patterns) {
    let match;
    let best = -1;
    while ((match = pattern.exec(window)) !== null) {
      const end = match.index + match[0].length;
      if (end >= minimum && end <= maxChars) best = end;
    }
    if (best > 0) return best;
  }
  const space = window.lastIndexOf(' ', maxChars);
  return space >= minimum ? space : Math.min(maxChars, text.length);
}

function splitTextForTtsPreview(value, maxChars = TTS_PREVIEW_SAFE_CHARS) {
  let remaining = String(value || '').replace(/\s+/g, ' ').trim();
  const chunks = [];
  while (remaining.length > maxChars) {
    const cut = speechBoundary(remaining, maxChars);
    const chunk = remaining.slice(0, cut).trim();
    if (!chunk) throw new Error('Could not split bulletin text safely for TTS.');
    chunks.push(chunk);
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  if (!chunks.length) throw new Error('No text was available for TTS.');
  if (chunks.some((chunk) => chunk.length > maxChars)) {
    throw new Error(`A TTS chunk exceeded the safe ${maxChars}-character limit.`);
  }
  return chunks;
}

let generatedSequence = 0;
function generatedPath(prefix, extension = 'wav') {
  generatedSequence = (generatedSequence + 1) % 1_000_000;
  return join(GENERATED_DIR, `${prefix}-${Date.now()}-${process.pid}-${generatedSequence}.${extension}`);
}

function normalizeAudio(inputPath, prefix) {
  const out = generatedPath(prefix);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inputPath, '-ar', '44100', '-ac', '2',
    '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

async function concatenateAudio(paths, prefix, pauseSeconds = 0) {
  if (!paths.length) throw new Error('No audio clips were supplied for concatenation.');
  const normalized = paths.map((path, index) => normalizeAudio(path, `${prefix}-part-${index + 1}`));
  if (normalized.length === 1) return normalized[0];

  let silence = null;
  if (pauseSeconds > 0) {
    silence = generatedPath(`${prefix}-pause`);
    run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-t', Number(pauseSeconds).toFixed(3),
      '-c:a', 'pcm_s16le', silence,
    ]);
  }

  const sequence = [];
  normalized.forEach((path, index) => {
    sequence.push(path);
    if (silence && index < normalized.length - 1) sequence.push(silence);
  });
  const listPath = generatedPath(`${prefix}-concat`, 'txt');
  const escaped = sequence.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n');
  await writeFile(listPath, `${escaped}\n`);
  const out = generatedPath(prefix);
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

async function synthesizeVoice(snapshot, config, presenter, text) {
  const voice = resolveVoice(snapshot, config, presenter);
  const response = await controllerRequest('/settings/tts/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...voice, text }),
  });
  const contentType = response.headers.get('content-type') || '';
  const ext = contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' : 'wav';
  const path = generatedPath('voice', ext);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  return { path, voice };
}

async function synthesizeCompleteStory(snapshot, config, presenter, story, storyIndex) {
  const chunks = splitTextForTtsPreview(story);
  if (chunks.length > 1) {
    await log(`TTS story ${storyIndex + 1} contains ${story.length} characters; rendering all of it in ${chunks.length} safe chunks because SUB/WAVE's preview endpoint keeps only 200 characters per request.`);
  }
  const paths = [];
  let resolvedVoice = null;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    // A punctuation-only continuation cue improves prosody when an unusually long
    // sentence had to be divided at a word boundary. It does not add spoken copy.
    const text = chunkIndex < chunks.length - 1 && !/[.!?…,:;—–\"'”’)]$/.test(chunk)
      ? `${chunk},`
      : chunk;
    const speech = await synthesizeVoice(snapshot, config, presenter, text);
    const seconds = durationOf(speech.path);
    if (seconds < 0.1) throw new Error(`TTS returned an empty clip for story ${storyIndex + 1}, chunk ${chunkIndex + 1}.`);
    paths.push(speech.path);
    resolvedVoice ||= speech.voice;
  }
  const path = await concatenateAudio(paths, `spoken-story-${storyIndex + 1}`, TTS_CHUNK_PAUSE_SECONDS);
  return { path, voice: resolvedVoice, chunks: chunks.length, duration: durationOf(path) };
}

async function makeNarrationAudio(config, speechPaths) {
  if (!speechPaths.length) throw new Error('No speech clips were generated.');
  return concatenateAudio(speechPaths, 'narration', speechPaths.length > 1 ? config.storyPauseSeconds : 0);
}

function run(command, args, options = {}) {
  const defaultTimeout = command === 'ffmpeg' ? FFMPEG_TIMEOUT_MS
    : command === 'ffprobe' ? FFPROBE_TIMEOUT_MS
      : undefined;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    ...(defaultTimeout ? { timeout: defaultTimeout, killSignal: 'SIGKILL' } : {}),
    ...options,
  });
  if (result.error) throw new Error(`${command} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
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

function protectedTailSeconds(crossfadeSeconds) {
  const crossfade = Math.min(60, Math.max(0, Number(crossfadeSeconds) || 0));
  // SUB/WAVE's custom liq_cross_duration annotation is retained, but some
  // Liquidsoap request/metadata paths can lose that override. A real silent tail
  // longer than the station crossfade makes the handoff safe even when the
  // mixer falls back to its global crossfade: it can only consume silence, never
  // the end of a spoken story.
  return Math.max(12.5, crossfade + 2.5);
}

async function makeFullPackage(bulletinPath, crossfadeSeconds = 10) {
  const programmeParts = [];
  const intro = join(ASSET_DIR, 'intro.wav');
  const outro = join(ASSET_DIR, 'outro.wav');
  if (existsSync(intro)) programmeParts.push(intro);
  programmeParts.push(bulletinPath);
  if (existsSync(outro)) programmeParts.push(outro);

  // Normalize every programme component before concat. Uploaded assets are
  // normally already 44.1 kHz stereo PCM, but doing this here makes the final
  // package independent of old assets created by earlier releases.
  const parts = programmeParts.map((path, index) => normalizeAudio(path, `package-programme-${index + 1}`));
  const contentDuration = parts.reduce((total, path) => total + durationOf(path), 0);
  const tailSeconds = protectedTailSeconds(crossfadeSeconds);
  const tail = generatedPath('package-protected-tail');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', tailSeconds.toFixed(3), '-c:a', 'pcm_s16le', tail,
  ]);
  parts.push(tail);

  const expectedDuration = contentDuration + tailSeconds;
  const out = generatedPath('news-package');
  const inputs = parts.flatMap((path) => ['-i', path]);
  const labels = parts.map((_, index) => `[${index}:a]`).join('');
  run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    ...inputs,
    '-filter_complex', `${labels}concat=n=${parts.length}:v=0:a=1[out]`,
    '-map', '[out]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  const duration = durationOf(out);
  if (duration + 0.15 < expectedDuration) {
    throw new Error(`Final bulletin package is incomplete (${duration.toFixed(2)}s rendered; expected at least ${expectedDuration.toFixed(2)}s).`);
  }
  return { path: out, duration, contentDuration, protectedTailSeconds: tailSeconds };
}

function liquidsoapCommand(command, timeoutMs = 3500) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection({ host: LIQUIDSOAP_HOST, port: LIQUIDSOAP_PORT });
    let buffer = '';
    let settled = false;
    const finish = (error, value = '') => {
      if (settled) return;
      settled = true;
      try { socket.end('quit\n'); } catch {}
      try { socket.destroy(); } catch {}
      if (error) reject(error); else resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => finish(new Error('Liquidsoap control timed out.')));
    socket.once('error', (error) => finish(error));
    socket.once('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (/END\r?\n/.test(buffer)) finish(null, buffer.replace(/END\r?\n.*$/s, '').trim());
    });
    socket.once('close', () => finish(null, buffer.trim()));
  });
}

function decodeMetadataValue(raw) {
  let value = String(raw || '').trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function initialUriFromMetadata(metadata) {
  const line = String(metadata || '').split(/\r?\n/)
    .find((entry) => entry.trim().startsWith('initial_uri='));
  if (!line) return '';
  return decodeMetadataValue(line.slice(line.indexOf('=') + 1));
}

function annotateValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function captureAndClearPendingQueue(excludedRids = new Set()) {
  const raw = await liquidsoapCommand('dj_queue.queue');
  const rids = String(raw).trim().split(/\s+/).filter(Boolean);
  const saved = [];
  for (const rid of rids) {
    if (excludedRids.has(String(rid))) continue;
    try {
      const metadata = await liquidsoapCommand(`request.metadata ${rid}`);
      const uri = initialUriFromMetadata(metadata);
      if (!uri) continue;
      const removed = await liquidsoapCommand(`dj_queue_remove ${rid}`);
      if (String(removed).trim() === 'OK') saved.push(uri);
    } catch (error) {
      await log(`Could not temporarily move queued request ${rid}: ${error.message}`);
    }
  }
  return saved;
}

async function pushLiquidsoapRequest(uri) {
  const result = await liquidsoapCommand(`dj_queue.push ${uri}`, 5000);
  if (/ERROR|invalid|failed/i.test(String(result))) {
    throw new Error(`Liquidsoap refused a queued item: ${result}`);
  }
  const rid = String(result).match(/\b\d+\b/)?.[0] || '';
  if (!rid) throw new Error(`Liquidsoap queued the item but returned no request id: ${result}`);
  return rid;
}

function requestIds(raw) {
  return Array.from(new Set(String(raw || '').match(/\b\d+\b/g) || []));
}

function metadataValue(metadata, key) {
  const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*(.*)$`);
  for (const line of String(metadata || '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return decodeMetadataValue(match[1]);
  }
  return '';
}

function traceShowsResolved(trace) {
  return /\bPushed \[/i.test(String(trace || '')) || /status\s*=\s*ready/i.test(String(trace || ''));
}

function traceFailure(trace) {
  const text = String(trace || '');
  const line = text.split(/\r?\n/).find((entry) => (
    /nonexistent file|ill-formed uri|no decoder|failed|error|timed? out/i.test(entry)
  ));
  return line ? line.trim() : '';
}

async function requestTrace(rid) {
  try { return await liquidsoapCommand(`request.trace ${rid}`, 3000); } catch { return ''; }
}

async function waitForRequestResolution(rid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let trace = '';
  while (Date.now() < deadline) {
    trace = await requestTrace(rid);
    if (traceShowsResolved(trace)) return { resolved: true, trace };
    const failure = traceFailure(trace);
    if (failure) return { resolved: false, trace, failure };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  return { resolved: false, trace, failure: 'resolution was not confirmed before timeout' };
}

async function waitForPreparedBulletinRequest(rootRid, packagePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastIds = [];
  let lastQueueIds = [];
  while (Date.now() < deadline) {
    try {
      const [allRaw, aliveRaw, queueRaw, resolvingRaw] = await Promise.all([
        liquidsoapCommand('request.all', 3000),
        liquidsoapCommand('request.alive', 3000),
        liquidsoapCommand('dj_queue.queue', 3000),
        liquidsoapCommand('request.resolving', 3000),
      ]);
      const resolving = new Set(requestIds(resolvingRaw).map(String));
      const queueIds = requestIds(queueRaw).map(String);
      const queued = new Set(queueIds);
      // Important: on the Liquidsoap build used by SUB/WAVE, an annotate: URI
      // often keeps the SAME RID after resolution and preparation. v0.5.7
      // incorrectly filtered rootRid out while waiting for a separate child RID.
      const ids = Array.from(new Set([
        String(rootRid),
        ...queueIds,
        ...requestIds(aliveRaw).map(String),
        ...requestIds(allRaw).map(String),
      ]));
      lastIds = ids;
      lastQueueIds = queueIds;
      for (const rid of ids) {
        let metadata = '';
        try { metadata = await liquidsoapCommand(`request.metadata ${rid}`, 3000); } catch { continue; }
        const filename = metadataValue(metadata, 'filename');
        const initialUri = metadataValue(metadata, 'initial_uri');
        const title = metadataValue(metadata, 'title');
        const rawMetadata = String(metadata || '');
        const matchesPath = (
          filename === packagePath
          || initialUri === packagePath
          || initialUri.includes(packagePath)
          || rawMetadata.includes(packagePath)
        );
        const matchesBulletin = matchesPath && (!title || title === 'Hourly News Bulletin');
        if (matchesBulletin && queued.has(String(rid)) && !resolving.has(String(rid))) {
          return { rid: String(rid), metadata, reusedResolverRid: String(rid) === String(rootRid) };
        }
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const visible = lastIds.length ? ` visible RIDs: ${lastIds.join(', ')}` : ' no visible RIDs';
  const queued = lastQueueIds.length ? `; dj_queue RIDs: ${lastQueueIds.join(', ')}` : '; dj_queue was empty';
  throw new Error(`Liquidsoap resolved the bulletin URI but did not expose the prepared bulletin request before timeout (${visible}${queued}).`);
}

async function waitForBulletinNowPlaying(notBeforeMs, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const info = fs.statSync(NOW_PLAYING_FILE);
      const parsed = JSON.parse(await readFile(NOW_PLAYING_FILE, 'utf8'));
      last = parsed;
      if (
        info.mtimeMs >= notBeforeMs - 1000
        && String(parsed?.title || '').trim() === 'Hourly News Bulletin'
        && String(parsed?.artist || '').trim() === 'SUB/WAVE News'
      ) {
        return parsed;
      }
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const description = last
    ? `${String(last.title || 'unknown')} by ${String(last.artist || 'unknown')}`
    : 'no readable now-playing metadata';
  throw new Error(`The bulletin was prepared, but SUB/WAVE still reported ${description} after one safe skip. No additional songs were skipped.`);
}

let bulletinPlaybackUntilMs = 0;
let bulletinPlaybackStartedAt = null;
let bulletinPlaybackDurationSeconds = 0;
let protectedHandoverTask = null;
let heldQueueState = null;

function bulletinPlaybackActive() {
  return Date.now() < bulletinPlaybackUntilMs || !!heldQueueState;
}

function armBulletinPlaybackGuard(startedAtMs, durationSeconds, safeRestoreAtMs) {
  const seconds = Math.max(1, Number(durationSeconds) || 1);
  bulletinPlaybackStartedAt = new Date(startedAtMs).toISOString();
  bulletinPlaybackDurationSeconds = seconds;
  // The lock lasts until the queue handback is safe, not merely until metadata
  // first says "Hourly News Bulletin". now-playing changes at crossfade start,
  // before the incoming programme item has reached full level.
  bulletinPlaybackUntilMs = Math.max(
    startedAtMs + Math.ceil(seconds * 1000) + 15000,
    Number(safeRestoreAtMs) || 0,
  );
}

async function currentNowPlaying() {
  try {
    return JSON.parse(await readFile(NOW_PLAYING_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function isNewsBulletinNowPlaying(value) {
  return String(value?.title || '').trim() === 'Hourly News Bulletin'
    && String(value?.artist || '').trim() === 'SUB/WAVE News';
}

async function restorePendingQueueDetailed(pending) {
  let restored = 0;
  const failed = [];
  for (const uri of pending) {
    try {
      await pushLiquidsoapRequest(uri);
      restored += 1;
    } catch (error) {
      failed.push(uri);
      await log(`Could not restore a pending song behind the bulletin: ${error.message}`);
    }
  }
  return { restored, failed };
}

async function restorePendingQueue(pending) {
  return (await restorePendingQueueDetailed(pending)).restored;
}

function mergeHeldUris(existing, incoming) {
  const out = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(out.map(String));
  for (const uri of incoming || []) {
    const value = String(uri || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

async function saveHeldQueueState(state) {
  heldQueueState = state;
  await saveJson(HELD_QUEUE_FILE, state);
}

async function clearHeldQueueState() {
  heldQueueState = null;
  await rm(HELD_QUEUE_FILE, { force: true }).catch(() => {});
}

async function protectHandoverUntilSafeEnd(initialState) {
  let state = initialState;
  await saveHeldQueueState(state);
  const excluded = new Set((state.excludedRids || []).map(String));
  const safeRestoreAtMs = Number(state.safeRestoreAtMs) || Date.now();
  const hardDeadlineMs = safeRestoreAtMs + 120000;
  await log(`Protected bulletin handover armed until ${new Date(safeRestoreAtMs).toISOString()}. Pending songs remain completely outside dj_queue until the verified package, protected silent tail, and crossfade safety window have elapsed.`);

  // SUB/WAVE may keep preloading tracks while the bulletin is on air. Drain any
  // new pending requests throughout the whole package, not just at handover.
  // This is intentionally a queue hold, never a skip.
  while (Date.now() < safeRestoreAtMs) {
    const appeared = await captureAndClearPendingQueue(excluded).catch(async (error) => {
      await log(`Protected queue sweep warning: ${error.message}`);
      return [];
    });
    if (appeared.length) {
      const merged = mergeHeldUris(state.pending, appeared);
      if (merged.length !== state.pending.length) {
        state = { ...state, pending: merged, updatedAt: new Date().toISOString() };
        await saveHeldQueueState(state);
        await log(`Held ${appeared.length} additional queued song${appeared.length === 1 ? '' : 's'} while the bulletin remained protected.`);
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  // At the expected end, wait for metadata to leave the bulletin as a final
  // confirmation. The package already contains a crossfade-length silent tail,
  // so this wait cannot consume speech. Never send an end skip.
  while (Date.now() < hardDeadlineMs && isNewsBulletinNowPlaying(await currentNowPlaying())) {
    const appeared = await captureAndClearPendingQueue(excluded).catch(() => []);
    if (appeared.length) {
      state = { ...state, pending: mergeHeldUris(state.pending, appeared), updatedAt: new Date().toISOString() };
      await saveHeldQueueState(state);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  // One final sweep closes the tiny race between the last monitor tick and queue
  // handback. auto_playlist can supply the first post-bulletin song while held
  // requests are restored safely behind it.
  const finalAppeared = await captureAndClearPendingQueue(excluded).catch(() => []);
  state = { ...state, pending: mergeHeldUris(state.pending, finalAppeared) };
  const totalHeld = state.pending.length;
  let restored = 0;
  let remaining = state.pending;
  for (let attempt = 1; attempt <= 5 && remaining.length; attempt++) {
    const result = await restorePendingQueueDetailed(remaining);
    restored += result.restored;
    remaining = result.failed;
    if (!remaining.length) break;
    state = {
      ...state,
      pending: remaining,
      restoreAttempt: attempt,
      updatedAt: new Date().toISOString(),
    };
    await saveHeldQueueState(state);
    await log(`Queue handback attempt ${attempt}/5 restored ${result.restored}; ${remaining.length} item${remaining.length === 1 ? '' : 's'} will retry in five seconds.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5000));
  }
  if (remaining.length) {
    throw new Error(`${remaining.length} held queue item${remaining.length === 1 ? '' : 's'} could not be restored after five attempts`);
  }
  await clearHeldQueueState();
  bulletinPlaybackUntilMs = 0;
  await log(`Bulletin handover completed without an end skip. Restored ${restored}/${totalHeld} held song${totalHeld === 1 ? '' : 's'} only after the full ${Number(state.packageDuration).toFixed(2)}s package and protected tail had elapsed.`);
  return restored;
}

function launchProtectedHandover(state) {
  if (protectedHandoverTask) return protectedHandoverTask;
  protectedHandoverTask = protectHandoverUntilSafeEnd(state)
    .catch(async (error) => {
      await log(`Protected handover recovery failed: ${error.message}. Held queue state remains on disk for restart recovery.`);
      throw error;
    })
    .finally(() => {
      protectedHandoverTask = null;
    });
  // The task intentionally outlives the HTTP run request. Catch here as well so
  // a failed background recovery never becomes an unhandled rejection.
  protectedHandoverTask.catch(() => {});
  return protectedHandoverTask;
}

function handoverState({ pending, bulletinRid, childRid, packagePath, packageDuration, protectedTail, outgoingCrossfadeSeconds, startedAtMs }) {
  const crossfade = Math.min(60, Math.max(0, Number(outgoingCrossfadeSeconds) || 0));
  // now-playing flips at the start of the incoming crossfade. Count that whole
  // crossfade before the package duration, then add a small decoder grace.
  const safeRestoreAtMs = startedAtMs + Math.ceil((crossfade + Number(packageDuration) + 5) * 1000);
  return {
    version: 1,
    pending: mergeHeldUris([], pending),
    excludedRids: [String(bulletinRid), String(childRid)].filter(Boolean),
    bulletinRid: String(bulletinRid || ''),
    childRid: String(childRid || ''),
    packagePath,
    packageDuration: Number(packageDuration),
    protectedTailSeconds: Number(protectedTail) || 0,
    outgoingCrossfadeSeconds: crossfade,
    startedAtMs,
    safeRestoreAtMs,
    createdAt: new Date().toISOString(),
  };
}

async function queueAsProgrammeItem(packagePath, packageDuration, protectedTail = 12.5, outgoingCrossfadeSeconds = 10) {
  const pending = await captureAndClearPendingQueue();
  const exitCrossfade = Math.min(60, Math.max(0, Number(outgoingCrossfadeSeconds) || 0));
  // Deliberately use the station crossfade at bulletin exit. The package ends in
  // a longer silent tail, so the next song fades in over silence after every
  // spoken word, never over the report itself. If the annotation is lost, the
  // mixer falls back to the same global crossfade and remains safe.
  const bulletinUri = `annotate:title="${annotateValue('Hourly News Bulletin')}",artist="${annotateValue('SUB/WAVE News')}",liq_cross_duration="${exitCrossfade.toFixed(3)}":${packagePath}`;
  let bulletinRid = '';
  let childRid = '';
  let handoverStarted = false;
  let state = null;
  let skipAt = 0;
  try {
    const alreadyPlaying = await currentNowPlaying();
    if (isNewsBulletinNowPlaying(alreadyPlaying) || bulletinPlaybackActive()) {
      throw new Error('A news bulletin is already on air. No handover skip was sent.');
    }

    bulletinRid = await pushLiquidsoapRequest(bulletinUri);
    await log(`Bulletin audio queued in Liquidsoap as resolver RID ${bulletinRid}; waiting for URI resolution. No song will be skipped until the exact package is ready.`);
    const resolution = await waitForRequestResolution(bulletinRid, 15000);
    if (!resolution.resolved) {
      throw new Error(`Liquidsoap could not resolve the bulletin request: ${resolution.failure}.${resolution.trace ? ` ${resolution.trace.slice(-500)}` : ''}`);
    }

    const prepared = await waitForPreparedBulletinRequest(bulletinRid, packagePath, 15000);
    childRid = prepared.rid;
    await log(`Bulletin resolver RID ${bulletinRid} is prepared in dj_queue as playable RID ${childRid}${prepared.reusedResolverRid ? ' (same RID)' : ''}.`);

    const appearedDuringPreparation = await captureAndClearPendingQueue(new Set([
      String(bulletinRid),
      String(childRid),
    ]));
    pending.push(...appearedDuringPreparation);
    await log(`Handover armed with the bulletin isolated at the front of dj_queue; ${mergeHeldUris([], pending).length} pending song${mergeHeldUris([], pending).length === 1 ? '' : 's'} will remain held until the entire package has ended.`);

    skipAt = Date.now();
    handoverStarted = true;
    await controllerRequest('/dj/skip', { method: 'POST' });
    await waitForBulletinNowPlaying(skipAt, 20000);
    const startedAtMs = Date.now();
    state = handoverState({
      pending,
      bulletinRid,
      childRid,
      packagePath,
      packageDuration,
      protectedTail,
      outgoingCrossfadeSeconds,
      startedAtMs,
    });
    armBulletinPlaybackGuard(startedAtMs, packageDuration, state.safeRestoreAtMs);
    await saveHeldQueueState(state);
    launchProtectedHandover(state);
    await log(`Bulletin is on air after exactly one delayed skip. The queue will stay empty for the full ${Number(packageDuration).toFixed(2)}s package, including ${Number(protectedTail).toFixed(2)}s of protected silence; no end skip will be sent.`);
    return { movedPending: state.pending.length, restoredPending: 0, bulletinRid, childRid, skipCount: 1, safeRestoreAt: new Date(state.safeRestoreAtMs).toISOString() };
  } catch (error) {
    if (!handoverStarted) {
      await restorePendingQueue(pending);
      if (childRid) {
        try { await liquidsoapCommand(`dj_queue_remove ${childRid}`); } catch {}
      }
    } else {
      // Once the one handover skip has been sent, restoring immediately is never
      // safe—even if metadata confirmation times out. Persist a conservative
      // queue hold and let restart recovery finish it without another skip.
      if (!state) {
        const startedAtMs = skipAt;
        state = handoverState({
          pending,
          bulletinRid,
          childRid,
          packagePath,
          packageDuration,
          protectedTail,
          outgoingCrossfadeSeconds: Math.max(30, Number(outgoingCrossfadeSeconds) || 0),
          startedAtMs,
        });
        armBulletinPlaybackGuard(startedAtMs, packageDuration, state.safeRestoreAtMs);
        await saveHeldQueueState(state).catch(() => {});
        launchProtectedHandover(state);
        await log(`Handover confirmation failed after the skip, so a conservative on-disk queue hold was armed instead of restoring songs early. No second skip will be sent.`);
      }
    }
    throw error;
  }
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
  if (isNewsBulletinNowPlaying(await currentNowPlaying())) {
    throw new Error('A bulletin is already on air. No new handover skip was sent.');
  }
  if (bulletinPlaybackActive()) {
    const remaining = Math.max(1, Math.ceil((bulletinPlaybackUntilMs - Date.now()) / 1000));
    throw new Error(`A bulletin is still on air. No new skip will be sent for approximately ${remaining} more seconds.`);
  }
  runBusy = true;
  const config = await settings();
  try {
    await log(`Bulletin started (${reason}).`);
    const { candidates, ledger, freshness } = await collectHeadlines(config);

    const snapshot = await subwaveSnapshot();
    const audienceInterests = await interests();
    const presenter = resolvePresenter(snapshot, config);
    const activeLlm = snapshot.values?.llm || snapshot.raw?.llm || {};
    await log(`Generating bulletin script with ${activeLlm.provider || 'unknown'}/${activeLlm.model || 'unknown'} (${freshness}; ${candidates.length} candidates).`);
    const generated = await generateBulletinText(snapshot, config, candidates, presenter, freshness, audienceInterests.profile);
    await log(`Bulletin script ready (${generated.stories.length} stories). Starting TTS.`);
    const speechPaths = [];
    let resolvedSpeech = null;
    let renderedChunks = 0;
    for (let storyIndex = 0; storyIndex < generated.stories.length; storyIndex++) {
      const story = generated.stories[storyIndex];
      await log(`Rendering complete TTS story ${storyIndex + 1}/${generated.stories.length}.`);
      const speech = await synthesizeCompleteStory(snapshot, config, presenter, story, storyIndex);
      speechPaths.push(speech.path);
      renderedChunks += speech.chunks;
      resolvedSpeech ||= speech;
      await log(`TTS story ${storyIndex + 1}/${generated.stories.length} complete (${speech.chunks} chunk${speech.chunks === 1 ? '' : 's'}; ${speech.duration.toFixed(2)}s).`);
    }
    const narration = await makeNarrationAudio(config, speechPaths);
    const bulletin = await makeBulletinAudio(config, narration);
    const packageInfo = await makeFullPackage(bulletin, snapshot.values?.crossfadeDuration);
    const packagePath = packageInfo.path;
    await log(`Verified complete intro/news/outro package (${packageInfo.contentDuration.toFixed(2)}s programme audio + ${packageInfo.protectedTailSeconds.toFixed(2)}s protected silent tail = ${packageInfo.duration.toFixed(2)}s total; ${generated.stories.length} stories; ${renderedChunks} TTS chunks).`);
    let playback;
    if (config.interruptCurrentTrack) {
      playback = await queueAsProgrammeItem(
        packagePath,
        packageInfo.duration,
        packageInfo.protectedTailSeconds,
        snapshot.values?.crossfadeDuration,
      );
    } else {
      await queueAudio(packagePath);
      playback = { movedPending: 0 };
    }

    if (freshness === 'fresh') {
      for (const item of candidates) ledger.add(item.key);
    }
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
    await log(`Bulletin queued in full (${freshness}; ${generated.stories.length} stories; ${renderedChunks} TTS chunks; ${packageInfo.duration.toFixed(2)}s package; ${config.storyPauseSeconds}s story gaps; ${config.interruptCurrentTrack ? 'programme-item handover with protected silent-tail crossfade' : 'foreground voice'}; moved ${playback.movedPending} pending tracks) with presenter ${presenter?.name || 'unknown'} using ${generated.provider}/${generated.model}, ${resolvedSpeech.voice.engine}/${resolvedSpeech.voice.voice || 'default'}: ${generated.text}`);
    return {
      ok: true,
      spoken: generated.text,
      freshness,
      storyCount: generated.stories.length,
      storyPauseSeconds: config.storyPauseSeconds,
      interruptedTrack: config.interruptCurrentTrack,
      packageDurationSeconds: packageInfo.duration,
      programmeAudioDurationSeconds: packageInfo.contentDuration,
      protectedTailSeconds: packageInfo.protectedTailSeconds,
      ttsChunkCount: renderedChunks,
    };
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
      // Keep the newest generated artefacts by modification time, not by filename.
      // Different prefixes (story-, silence-, narration-, news-package-) do not
      // sort chronologically. The old lexical cleanup could delete the brand-new
      // news-package immediately after queueing it, before Liquidsoap opened the
      // resolved child request, producing a "Nonexistent file" race on air.
      const generated = await Promise.all(
        (await readdir(GENERATED_DIR))
          .filter((name) => /\.(wav|mp3|txt)$/i.test(name))
          .map(async (name) => {
            const path = join(GENERATED_DIR, name);
            const info = await stat(path);
            return { path, mtimeMs: info.mtimeMs };
          }),
      );
      generated.sort((a, b) => b.mtimeMs - a.mtimeMs);
      await Promise.all(generated.slice(32).map((item) => rm(item.path, { force: true })));
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
  if (!config.enabled || config.scheduleMode === 'manual' || runBusy || bulletinPlaybackActive()) return;
  if (isNewsBulletinNowPlaying(await currentNowPlaying())) return;

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

async function recoverHeldQueueOnStartup() {
  if (!existsSync(HELD_QUEUE_FILE)) return;
  const state = await loadJson(HELD_QUEUE_FILE, null);
  if (!state || !Array.isArray(state.pending) || !Number.isFinite(Number(state.safeRestoreAtMs))) {
    await log('Discarding malformed held-queue recovery state.');
    await clearHeldQueueState();
    return;
  }
  armBulletinPlaybackGuard(
    Number(state.startedAtMs) || Date.now(),
    Number(state.packageDuration) || 1,
    Number(state.safeRestoreAtMs),
  );
  heldQueueState = state;
  await log(`Recovered ${state.pending.length} held song${state.pending.length === 1 ? '' : 's'} from disk after manager restart. The queue remains protected until the bulletin-safe handback time.`);
  launchProtectedHandover(state);
}

await recoverHeldQueueOnStartup().catch((error) => log(`Held queue startup recovery warning: ${error.message}`));
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
  return run('git', ['-c', `safe.directory=${EXTENSION_DIR}`, '-C', EXTENSION_DIR, ...args]);
}

const VERSION_CHECK_TTL_MS = 60 * 1000;
let remoteVersionCache = null;

function remoteMainCommit() {
  const result = spawnSync(
    'git',
    ['-c', `safe.directory=${EXTENSION_DIR}`, '-C', EXTENSION_DIR, 'ls-remote', '--heads', 'origin', 'refs/heads/main'],
    { encoding: 'utf8', timeout: 15000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'git ls-remote failed').trim());
  }
  const sha = String(result.stdout || '').trim().split(/\s+/)[0] || '';
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('The remote main branch returned no commit id.');
  return sha;
}

async function remoteMainVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/VERSION?cache=${Date.now()}`;
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!response.ok) throw new Error(`remote VERSION returned HTTP ${response.status}`);
    const value = (await response.text()).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) {
      throw new Error('remote VERSION did not contain a valid release number');
    }
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function versionStatus(force = false) {
  let installedCommit = null;
  let latestCommit = null;
  let latestVersion = null;
  let version = 'unknown';
  const errors = [];
  try { installedCommit = git(['rev-parse', 'HEAD']); } catch (error) { errors.push(`installed commit: ${error.message}`); }
  try { version = (await readFile(join(EXTENSION_DIR, 'VERSION'), 'utf8')).trim(); } catch (error) { errors.push(`installed VERSION: ${error.message}`); }

  const now = Date.now();
  if (!force && remoteVersionCache && now - remoteVersionCache.checkedAt < VERSION_CHECK_TTL_MS) {
    ({ latestCommit, latestVersion } = remoteVersionCache);
    if (remoteVersionCache.updateCheckError) errors.push(remoteVersionCache.updateCheckError);
  } else {
    const remoteErrors = [];
    try { latestCommit = remoteMainCommit(); } catch (error) { remoteErrors.push(`remote commit: ${error.message}`); }
    try { latestVersion = await remoteMainVersion(); } catch (error) { remoteErrors.push(`remote VERSION: ${error.message}`); }
    const updateCheckError = (!latestCommit && !latestVersion) ? remoteErrors.join('; ') : null;
    remoteVersionCache = { latestCommit, latestVersion, updateCheckError, checkedAt: now };
    if (updateCheckError) errors.push(updateCheckError);
  }

  const commitDiffers = Boolean(installedCommit && latestCommit && installedCommit !== latestCommit);
  const versionDiffers = Boolean(version !== 'unknown' && latestVersion && version !== latestVersion);
  return {
    version,
    latestVersion,
    installedCommit,
    latestCommit,
    updateAvailable: commitDiffers || versionDiffers,
    updateCheckError: (!latestCommit && !latestVersion) ? (errors.join('; ') || 'No remote release information was available.') : null,
    updateCheckedAt: remoteVersionCache ? new Date(remoteVersionCache.checkedAt).toISOString() : null,
  };
}

function updaterContainer(command) {
  const name = `subwave-news-${command}-${Date.now()}`;
  let checkoutOwner = { uid: 0, gid: 0 };
  try { checkoutOwner = fs.statSync(EXTENSION_DIR); } catch {}
  const args = [
    'run', '-d', '--rm', '--name', name,
    '--memory', '512m', '--cpus', '1.0', '--pids-limit', '128',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${EXTENSION_DIR}:${EXTENSION_DIR}`,
    '-v', `${SUBWAVE_DIR}:${SUBWAVE_DIR}`,
    '-v', `${HOST_STATE_DIR}:/var/sub-wave`,
    '-w', EXTENSION_DIR,
    '-e', `EXTENSION_DIR=${EXTENSION_DIR}`,
    '-e', `SUBWAVE_DIR=${SUBWAVE_DIR}`,
    '-e', `SUBWAVE_STATE_DIR=${HOST_STATE_DIR}`,
    // DATA_DIR is the path inside this updater container; the Compose bind source
    // above still uses the real host path through SUBWAVE_STATE_DIR.
    '-e', 'DATA_DIR=/var/sub-wave/extensions/hourly-news',
    '-e', `SUBWAVE_NETWORK=${SUBWAVE_NETWORK}`,
    '-e', `MANAGER_PORT=${MANAGER_PORT}`,
    '-e', `HOST_REPO_UID=${checkoutOwner.uid}`,
    '-e', `HOST_REPO_GID=${checkoutOwner.gid}`,
    '-e', 'COMPOSE_PARALLEL_LIMIT=1',
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
app.disable('etag');
app.use(preventAdminCaching);

// Keep the shell and its static files public so an expired browser Basic-Auth
// cache can display a useful re-authentication screen instead of a blank page.
// Every API, upload, preview, update and rollback route remains protected below.
app.get('/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));
app.get(['/', '/index.html'], (_req, res) => {
  res.type('html').send(renderedIndex());
});
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: false,
  lastModified: false,
  maxAge: 0,
}));

// A top-level navigation to this protected endpoint reliably causes the browser
// to show its Basic-Auth prompt. After successful authentication, return to the
// manager page using a relative URL so the /news-bulletin/ proxy prefix survives.
app.get('/reauth', requireAuth, (_req, res) => {
  const stamp = Date.now();
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Authenticated</title><script>location.replace(new URL('./?reauthenticated=${stamp}', location.href).href)</script>`);
});

app.use(requireAuth);
app.use(express.json({ limit: '1mb' }));
app.get('/api/auth-check', (_req, res) => res.json({ ok: true, version: APP_VERSION }));

app.get('/api/settings', async (_req, res) => {
  const config = await settings();
  const assets = await assetSnapshot();

  let options = {
    onAirPersonaId: '',
    personas: [],
    engines: ['piper', 'kokoro', 'chatterbox', 'pocket-tts', 'cloud', 'remote'],
    availableEngines: {},
    voices: {},
    cloudProviders: [],
  };
  try {
    options = subwaveOptions(await subwaveSnapshot());
  } catch (error) {
    await log(`Could not load presenter/voice options: ${error.message}`);
  }

  const audienceInterests = await interests();
  res.json({
    settings: config,
    assets,
    interests: publicInterests(audienceInterests),
    options,
    defaults: {
      storySelectionInstructions: DEFAULTS.storySelectionInstructions,
      articleHandlingInstructions: DEFAULTS.articleHandlingInstructions,
      deliveryInstructions: DEFAULTS.deliveryInstructions,
    },
  });
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


app.get('/api/interests/articles', async (_req, res) => {
  try {
    const config = await settings();
    const result = await collectInterestArticles(config);
    const audienceInterests = await interests();
    const ratings = {};
    for (const item of audienceInterests.likes) ratings[item.key] = 'like';
    for (const item of audienceInterests.dislikes) ratings[item.key] = 'dislike';
    res.json({ ...result, ratings });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/interests/generate', async (req, res) => {
  try {
    const current = await interests();
    const merged = mergeInterestSelections(current, req.body?.selections, req.body?.visibleKeys);
    if (!merged.likes.length && !merged.dislikes.length) {
      throw new Error('Mark at least one article as More like this or Less like this first.');
    }
    const snapshot = await subwaveSnapshot();
    await log(`Generating audience interest profile from ${merged.likes.length} positive and ${merged.dislikes.length} negative examples.`);
    const profile = await generateInterestProfile(snapshot, merged.likes, merged.dislikes);
    if (!profile) throw new Error('The LLM returned an empty interest profile.');
    const saved = {
      profile,
      likes: merged.likes,
      dislikes: merged.dislikes,
      updatedAt: new Date().toISOString(),
      generatedAt: new Date().toISOString(),
    };
    await saveJson(INTERESTS_FILE, saved);
    await log('Audience interest profile updated.');
    res.json({ ok: true, interests: publicInterests(saved) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put('/api/interests/profile', async (req, res) => {
  try {
    const current = await interests();
    const saved = {
      ...current,
      profile: cleanInterestProfile(req.body?.profile),
      updatedAt: new Date().toISOString(),
    };
    await saveJson(INTERESTS_FILE, saved);
    await log(saved.profile ? 'Audience interest profile edited manually.' : 'Audience interest profile text cleared; examples retained.');
    res.json({ ok: true, interests: publicInterests(saved) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/interests', async (_req, res) => {
  const cleared = { ...INTEREST_DEFAULTS, updatedAt: new Date().toISOString() };
  await saveJson(INTERESTS_FILE, cleared);
  await log('Audience interest profile and examples reset.');
  res.json({ ok: true, interests: publicInterests(cleared) });
});

app.post('/api/assets/:type', upload.single('file'), async (req, res) => {
  try {
    if (!ASSET_TYPES.includes(req.params.type)) throw new Error('Unknown asset.');
    if (!req.file) throw new Error('Choose an audio file first.');
    await convertUpload(req.file, req.params.type);
    const metadata = await assetMetadata();
    metadata[req.params.type] = {
      fileName: basename(String(req.file.originalname || `${req.params.type}.wav`)).slice(0, 255),
      uploadedAt: new Date().toISOString(),
    };
    await saveJson(ASSET_META_FILE, metadata);
    const assets = await assetSnapshot();
    res.json({ ok: true, asset: assets[req.params.type] });
  } catch (error) {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/assets/:type', async (req, res) => {
  if (!ASSET_TYPES.includes(req.params.type)) return res.status(400).send('Unknown asset.');
  const path = join(ASSET_DIR, `${req.params.type}.wav`);
  if (!existsSync(path)) return res.status(404).send('No audio uploaded.');
  res.type('audio/wav').sendFile(path);
});

app.delete('/api/assets/:type', async (req, res) => {
  if (!ASSET_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Unknown asset.' });
  await rm(join(ASSET_DIR, `${req.params.type}.wav`), { force: true });
  const metadata = await assetMetadata();
  delete metadata[req.params.type];
  await saveJson(ASSET_META_FILE, metadata);
  res.json({ ok: true });
});

app.post('/api/run', async (_req, res) => {
  try {
    res.json(await runBulletin('manual'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/status', async (req, res) => {
  const config = await settings();
  let subwave = {
    connected: false,
    error: null,
    persona: null,
    onAirPersona: null,
    llm: null,
    tts: null,
  };
  try {
    const snapshot = await subwaveSnapshot();
    const llm = snapshot.values?.llm || snapshot.raw?.llm || {};
    const presenter = resolvePresenter(snapshot, config);
    const voice = resolveVoice(snapshot, config, presenter);
    subwave = {
      connected: true,
      error: null,
      persona: presenter?.name || null,
      onAirPersona: snapshot.onAirPersona?.name || null,
      llm: `${llm.provider || '?'} / ${llm.model || '?'}`,
      tts: `${voice.engine} / ${voice.voice || 'default'}`,
    };
  } catch (error) {
    subwave.error = error.message;
  }
  const nowPlaying = await currentNowPlaying();
  const bulletinOnAir = bulletinPlaybackActive() || isNewsBulletinNowPlaying(nowPlaying);
  res.json({
    manager: 'running',
    busy: runBusy,
    bulletinOnAir,
    bulletinPlaybackStartedAt,
    bulletinPlaybackDurationSeconds,
    bulletinPlaybackRemainingSeconds: bulletinPlaybackActive()
      ? Math.max(1, Math.ceil((bulletinPlaybackUntilMs - Date.now()) / 1000))
      : 0,
    lastRunAt: config.lastRunAt,
    lastRunStatus: config.lastRunStatus,
    subwave,
    ...(await versionStatus(req.query.refresh === '1')),
  });
});

app.get('/api/logs', async (_req, res) => {
  try {
    res.type('text/plain').send(await readTail(LOG_FILE));
  } catch (error) {
    res.status(500).type('text/plain').send(`Could not read recent actions: ${error.message}`);
  }
});

app.delete('/api/logs', async (_req, res) => {
  logMaintenance = logMaintenance.then(
    () => writeFile(LOG_FILE, ''),
    () => writeFile(LOG_FILE, ''),
  );
  await logMaintenance;
  res.json({ ok: true, message: 'Recent actions cleared.' });
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
