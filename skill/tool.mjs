// Native SUB/WAVE fallback tool for the standalone Hourly News companion.
// The manager supplies the full audio package. Running this skill directly from
// SUB/WAVE produces a plain spoken bulletin using the same configured feeds.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const SETTINGS = '/var/sub-wave/extensions/hourly-news/settings.json';
const MAX_FEEDS = 12;

export const description =
  'Fetch fresh headlines from every RSS feed configured in the Hourly News Manager.';

async function settings() {
  try {
    return JSON.parse(await readFile(SETTINGS, 'utf8'));
  } catch {
    return {
      feeds: [
        { name: 'Guardian Australia', url: 'https://www.theguardian.com/australia-news/rss' },
        { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      ],
      maxItemsPerFeed: 8,
      maxCandidates: 12,
    };
  }
}

function titleKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export default async function hourlyNews(_ctx, _state, services) {
  const config = await settings();
  const feeds = (Array.isArray(config.feeds) ? config.feeds : [])
    .filter((feed) => feed?.url)
    .slice(0, MAX_FEEDS);

  if (!feeds.length) return { available: false, headlines: [], reason: 'no RSS feeds configured' };

  const settled = await Promise.allSettled(
    feeds.map(async (feed) => ({
      feed,
      items: await services.fetchHeadlines({
        feedUrl: feed.url,
        maxItems: Number(config.maxItemsPerFeed) || 8,
      }),
    })),
  );

  const buckets = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      services.log(`hourly-news-bulletin: ${feeds[index].name || feeds[index].url} failed`);
      return;
    }
    const name = result.value.feed.name || new URL(result.value.feed.url).hostname;
    const items = (result.value.items || []).map((item) => ({
      title: item.title,
      description: item.description || null,
      source: name,
    }));
    if (items.length) buckets.push(items);
  });

  const merged = [];
  const localSeen = new Set();
  for (let row = 0; merged.length < (Number(config.maxCandidates) || 12) * 2; row++) {
    let found = false;
    for (const bucket of buckets) {
      const item = bucket[row];
      if (!item) continue;
      found = true;
      const key = titleKey(item.title);
      if (!key || localSeen.has(key)) continue;
      localSeen.add(key);
      merged.push(item);
    }
    if (!found) break;
  }

  const fresh = merged.filter((item) => {
    const key = `hourly-news-bulletin:${digest(titleKey(item.title))}`;
    return !services.recall.seen(key);
  }).slice(0, Number(config.maxCandidates) || 12);

  for (const item of fresh) {
    services.recall.remember(`hourly-news-bulletin:${digest(titleKey(item.title))}`);
  }

  return fresh.length
    ? { available: true, headlines: fresh }
    : { available: false, headlines: [], reason: 'no fresh headlines' };
}
