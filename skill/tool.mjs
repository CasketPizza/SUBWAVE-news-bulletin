// Native SUB/WAVE fallback tool for the Hourly News Bulletin.
//
// The companion manager uses the same settings file but provides the complete
// intro -> background bed + speech -> outro package. Running this skill directly
// from SUB/WAVE still gives a normal spoken bulletin without the audio package.

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

export default async function hourlyNews(ctx, state, services) {
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
    const key = `hourly-news-bulletin:${services.hashHeadline(titleKey(item.title))}`;
    return !services.recall.seen(key);
  }).slice(0, Number(config.maxCandidates) || 12);

  for (const item of fresh) {
    services.recall.remember(
      `hourly-news-bulletin:${services.hashHeadline(titleKey(item.title))}`,
    );
  }

  return fresh.length
    ? { available: true, headlines: fresh }
    : { available: false, headlines: [], reason: 'no fresh headlines' };
}
