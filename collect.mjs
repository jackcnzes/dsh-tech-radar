#!/usr/bin/env node
/**
 * 采集入口（多主题版）。
 *
 *   node collect.mjs                          # 跑 config.json 的 activeTopics
 *   node collect.mjs --topics=tech,sports     # 临时指定主题
 *   node collect.mjs --all                    # 忽略已读，按时间窗取全量
 *   node collect.mjs --topics=auto --dry      # 调试：不更新已读状态
 *   node collect.mjs --source=hn,github       # 只跑指定来源
 *
 * 主题定义在 topics/<id>.json；GUI 插件写到 state/topics.json，优先级高于 config。
 * 产物：data/items-YYYY-MM-DD.json（每条带 topics 数组）、data/voices-YYYY-MM-DD.json
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError, getJson, getText, sleep } from './lib/http.mjs';
import {
  parseArxiv,
  parseBilibili,
  parseFeed,
  parseGitHubSearch,
  parseGitHubTrending,
  parseHackerNews,
  parseTelegram,
  parseXTimeline,
} from './lib/parse.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const argValue = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const onlySources = argValue('source') ? new Set(argValue('source').split(',')) : null;

const day = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
};

const TODAY = day();
const config = JSON.parse(await readFile(join(CODE_ROOT, 'config.json'), 'utf8'));

/**
 * 代码与配置在本目录（插件包），运行产物在 outputDir。
 * 产物目录单独放，是为了不把每天的采集结果和简报塞进可发布/可安装的包里。
 */
const OUT = resolve(CODE_ROOT, config.outputDir ?? '../tech-radar');

/* ------------------------------------------------------------ 来源开关 */

/** 默认开关来自 config.sources，GUI 写入的 state/sources.json 优先。 */
async function loadSourceSwitches() {
  const defaults = { x: true, rss: true, hn: true, github: true, arxiv: true, telegram: false, bilibili: false };
  const merged = { ...defaults, ...(config.sources ?? {}) };
  try {
    const state = JSON.parse(await readFile(join(CODE_ROOT, 'settings', 'sources.json'), 'utf8'));
    for (const [id, value] of Object.entries(state.enabled ?? {})) {
      if (typeof value === 'boolean') merged[id] = value;
    }
  } catch {
    // 没有 GUI 状态就用默认值
  }
  return merged;
}

const sources = await loadSourceSwitches();

/* ------------------------------------------------------------------ 主题 */

async function loadTopicPacks() {
  const files = (await readdir(join(CODE_ROOT, 'topics'))).filter((name) => name.endsWith('.json'));
  const packs = new Map();
  for (const name of files) {
    const pack = JSON.parse(await readFile(join(CODE_ROOT, 'topics', name), 'utf8'));
    if (!pack.id) throw new Error(`topics/${name} 缺少 id`);
    packs.set(pack.id, pack);
  }
  return packs;
}

const topicPacks = await loadTopicPacks();

/** 优先级：命令行 > GUI 写入的 state/topics.json > config.activeTopics */
async function pickActiveTopicIds() {
  const fromCli = argValue('topics');
  if (fromCli) return fromCli.split(',').map((id) => id.trim()).filter(Boolean);

  try {
    const state = JSON.parse(await readFile(join(CODE_ROOT, 'settings', 'topics.json'), 'utf8'));
    if (Array.isArray(state.active) && state.active.length > 0) {
      console.error(`[tech-radar] 使用 GUI 选择的主题：${state.active.join(', ')}`);
      return state.active;
    }
  } catch {
    // 没有 GUI 状态文件，回落到 config
  }
  return config.activeTopics ?? ['tech'];
}

const activeIds = (await pickActiveTopicIds()).filter((id) => {
  if (topicPacks.has(id)) return true;
  console.error(`[tech-radar] 未知主题 "${id}"，已跳过（可用：${[...topicPacks.keys()].join(', ')}）`);
  return false;
});

if (activeIds.length === 0) {
  console.error('[tech-radar] 没有可用的主题，退出');
  process.exit(1);
}

const active = activeIds.map((id) => topicPacks.get(id));
console.error(`\n[tech-radar] ${TODAY}  主题：${active.map((t) => `${t.emoji ?? ''}${t.name}`).join(' / ')}`);

/* -------------------------------------------------------------- 源合并 */

const rssPlan = new Map(); // url -> { feed, topics:Set }
const xPlan = new Map();   // handle -> { handle, person, topics:Set }
const hnCfg = { enabled: false, minPoints: Infinity, limit: 0 };
const githubCfg = { enabled: false, since: 'daily', limit: 0 };
const arxivCfg = { enabled: false, categories: new Set(), limit: 0 };

for (const topic of active) {
  for (const feed of topic.rss ?? []) {
    const entry = rssPlan.get(feed.url) ?? { feed, topics: new Set() };
    entry.topics.add(topic.id);
    rssPlan.set(feed.url, entry);
  }
  for (const handle of topic.x?.handles ?? []) {
    const entry = xPlan.get(handle) ?? { handle, person: null, topics: new Set() };
    entry.topics.add(topic.id);
    xPlan.set(handle, entry);
  }
  for (const person of topic.influencers ?? []) {
    const entry = xPlan.get(person.handle) ?? { handle: person.handle, person, topics: new Set() };
    entry.person = person;
    entry.topics.add(topic.id);
    xPlan.set(person.handle, entry);
  }
  if (topic.hackernews?.enabled !== false) {
    hnCfg.enabled = true;
    hnCfg.minPoints = Math.min(hnCfg.minPoints, topic.hackernews?.minPoints ?? 80);
    hnCfg.limit = Math.max(hnCfg.limit, topic.hackernews?.limit ?? 30);
  }
  if (topic.github?.enabled !== false) {
    githubCfg.enabled = true;
    githubCfg.limit = Math.max(githubCfg.limit, topic.github?.limit ?? 15);
  }
  if (topic.arxiv?.enabled !== false) {
    arxivCfg.enabled = true;
    arxivCfg.limit = Math.max(arxivCfg.limit, topic.arxiv?.limit ?? 15);
    for (const category of topic.arxiv?.categories ?? []) arxivCfg.categories.add(category);
  }
}

/* ---------------------------------------------------------------- 采集 */

const collectors = [];

if (sources.x && xPlan.size > 0) {
  collectors.push(['x', async () => {
    const reader = config.x?.reader ?? 'https://r.jina.ai/';
    const delayMs = config.x?.delayMs ?? 1200;
    const allPosts = [];
    let networkMisses = 0;

    for (const entry of xPlan.values()) {
      try {
        const markdown = await getText(`${reader}https://x.com/${entry.handle}`, {
          timeoutMs: 20_000,
          retries: 0,
        });
        const limit = entry.person ? (config.influencers?.maxPosts ?? 6) : (config.x?.maxPerHandle ?? 8);
        const posts = parseXTimeline(markdown, entry.handle, limit);
        for (const post of posts) post.sourceTopics = [...entry.topics];
        allPosts.push(...posts);
        if (entry.person) entry.posts = posts;
        networkMisses = 0;
      } catch (error) {
        console.error(`      @${entry.handle}: ${error.message}`);
        // 只有网络类失败才计入熔断；404 之类是账号不存在，不该拖垮整轮
        const networkFailure = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
        if (networkFailure && ++networkMisses >= 2) {
          console.error('      X 连续网络失败，跳过剩余账号（检查代理 / r.jina.ai）');
          break;
        }
        if (!networkFailure) networkMisses = 0;
      }
      await sleep(delayMs);
    }
    return allPosts;
  }]);
}

for (const [url, entry] of rssPlan) {
  if (!sources.rss) break;
  collectors.push([`rss:${entry.feed.name}`, async () => {
    const xml = await getText(url, { timeoutMs: 30_000, retries: 1 });
    return parseFeed(xml, entry.feed.name, entry.feed.weight ?? 1).map((item) => ({
      ...item,
      sourceTopics: [...entry.topics],
    }));
  }]);
}

if (sources.hn && hnCfg.enabled) {
  collectors.push(['hn', async () => {
    const since = Math.floor((Date.now() - (config.briefing?.lookbackHours ?? 24) * 3_600_000) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${hnCfg.limit}`
      + `&numericFilters=created_at_i>${since},points>${hnCfg.minPoints}`;
    return parseHackerNews(await getJson(url)).map((item) => ({ ...item, sourceTopics: activeIds }));
  }]);
}

if (sources.github && githubCfg.enabled) {
  collectors.push(['github', async () => {
    try {
      const html = await getText(`https://github.com/trending?since=${githubCfg.since ?? 'daily'}`, {
        timeoutMs: 20_000, retries: 1,
      });
      return parseGitHubTrending(html, githubCfg.limit).map((item) => ({ ...item, sourceTopics: activeIds }));
    } catch (error) {
      console.error(`      trending 页不可达（${error.message}），改用 GitHub Search API`);
      const sinceDate = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      const json = await getJson(
        `https://api.github.com/search/repositories?q=created:>${sinceDate}&sort=stars&order=desc&per_page=${githubCfg.limit}`,
        { headers: { accept: 'application/vnd.github+json' }, timeoutMs: 20_000, retries: 1 },
      );
      return parseGitHubSearch(json, githubCfg.limit).map((item) => ({ ...item, sourceTopics: activeIds }));
    }
  }]);
}

if (sources.arxiv && arxivCfg.enabled && arxivCfg.categories.size > 0) {
  collectors.push(['arxiv', async () => {
    const query = [...arxivCfg.categories].map((category) => `cat:${category}`).join('+OR+');
    const url = `https://export.arxiv.org/api/query?search_query=${query}`
      + `&sortBy=submittedDate&sortOrder=descending&max_results=${arxivCfg.limit}`;
    return parseArxiv(await getText(url, { timeoutMs: 60_000 }), arxivCfg.limit)
      .map((item) => ({ ...item, sourceTopics: activeIds }));
  }]);
}

const telegramChannels = new Map(); // channel -> topics:Set
for (const topic of active) {
  for (const channel of topic.telegram ?? []) {
    const entry = telegramChannels.get(channel) ?? { channel, topics: new Set() };
    entry.topics.add(topic.id);
    telegramChannels.set(channel, entry);
  }
}

if (sources.telegram && telegramChannels.size > 0) {
  collectors.push(['telegram', async () => {
    const all = [];
    for (const [channel, entry] of telegramChannels) {
      try {
        const html = await getText(`https://t.me/s/${channel}`, { timeoutMs: 20_000, retries: 1 });
        all.push(...parseTelegram(html, channel).map((item) => ({
          ...item,
          sourceTopics: [...entry.topics],
        })));
      } catch (error) {
        console.error(`      t.me/${channel}: ${error.message}`);
      }
      await sleep(800);
    }
    return all;
  }]);
}

if (sources.bilibili) {
  collectors.push(['bilibili', async () => {
    const json = await getJson('https://api.bilibili.com/x/web-interface/ranking/v2', {
      headers: { referer: 'https://www.bilibili.com/' },
      timeoutMs: 20_000,
      retries: 1,
    });
    return parseBilibili(json, 30).map((item) => ({ ...item, sourceTopics: activeIds }));
  }]);
}

async function runSource(name, collector) {
  if (onlySources && ![...onlySources].some((prefix) => name.startsWith(prefix))) return [];
  const started = Date.now();
  try {
    const items = await collector();
    console.error(`  ✓ ${name.padEnd(22)} ${String(items.length).padStart(3)} 条  ${Date.now() - started}ms`);
    return items;
  } catch (error) {
    console.error(`  ✗ ${name.padEnd(22)} 失败: ${error.message}`);
    return [];
  }
}

const batches = await Promise.all(collectors.map(([name, collector]) => runSource(name, collector)));
const all = batches.flat().filter((item) => Boolean(item.title));

/* ------------------------------------------------------------ 相关性 */

function keywordMatch(item, keywords) {
  if (!keywords?.length) return true;
  const haystack = `${item.title} ${item.text}`.toLowerCase();
  return keywords.some((word) => haystack.includes(word.toLowerCase()));
}

const tagged = all.map((item) => {
  const kept = (item.sourceTopics ?? []).filter((id) => {
    const topic = topicPacks.get(id);
    const filterSources = new Set(topic.filterSources ?? ['hn', 'rss', 'bilibili']);
    return !filterSources.has(item.source) || keywordMatch(item, topic.keywords);
  });
  return { ...item, topics: kept, topicMatch: kept.length > 0 };
}).filter((item) => item.topics.length > 0);

/* ---------------------------------------------------------- 跨日去重 */

async function loadHistory() {
  const reportedUrls = new Set();
  const priorXIds = new Set();
  const priorXTitles = new Set();

  try {
    const briefs = (await readdir(join(OUT, 'briefings')))
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name < `${TODAY}.md`)
      .sort().slice(-3);
    for (const name of briefs) {
      const text = await readFile(join(OUT, 'briefings', name), 'utf8');
      for (const match of text.matchAll(/\((https?:\/\/[^)]+)\)/g)) reportedUrls.add(match[1]);
    }
  } catch { /* 首次运行没有 briefings/ */ }

  try {
    const datasets = (await readdir(join(OUT, 'data')))
      .filter((name) => /^items-\d{4}-\d{2}-\d{2}\.json$/.test(name) && name < `items-${TODAY}.json`);
    for (const name of datasets) {
      const dataset = JSON.parse(await readFile(join(OUT, 'data', name), 'utf8'));
      for (const item of dataset.items ?? []) {
        if (item.source !== 'x') continue;
        priorXIds.add(item.id);
        priorXTitles.add(item.title);
      }
    }
  } catch { /* 同上 */ }

  return { reportedUrls, priorXIds, priorXTitles };
}

const history = await loadHistory();
const seen = await (async () => {
  try {
    return JSON.parse(await readFile(join(OUT, 'state', 'seen.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const cutoff = Date.now() - (config.briefing?.lookbackHours ?? 24) * 3_600_000;

const fresh = tagged.filter((item) => {
  if (item.publishedAt && new Date(item.publishedAt).getTime() < cutoff) return false;
  if (item.source === 'x' && (history.priorXIds.has(item.id) || history.priorXTitles.has(item.title))) return false;
  if (item.url && history.reportedUrls.has(item.url)) return false;
  if (flag('all')) return true;
  return !seen[item.id];
});

const unique = [...new Map(fresh.map((item) => [item.id, item])).values()];
unique.sort((a, b) => score(b) - score(a));

function score(item) {
  const metrics = item.metrics ?? {};
  const base =
    (metrics.points ?? 0) / 50 +
    (metrics.starsToday ?? 0) / 300 +
    (metrics.comments ?? 0) / 40 +
    (metrics.weight ?? 1);
  const fade = item.publishedAt
    ? Math.max(0, 1 - (Date.now() - new Date(item.publishedAt).getTime()) / (36 * 3_600_000))
    : 0.5;
  return base * fade;
}

/* ---------------------------------------------------------------- 输出 */

const topicStats = active.map((topic) => ({
  id: topic.id,
  name: topic.name,
  emoji: topic.emoji,
  count: unique.filter((item) => item.topics.includes(topic.id)).length,
}));

const payload = {
  generatedAt: new Date().toISOString(),
  day: TODAY,
  mode: flag('all') ? 'all' : 'new',
  topics: topicStats,
  stats: {
    fetched: all.length,
    onTopic: tagged.length,
    fresh: fresh.length,
    kept: unique.length,
    bySource: unique.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] ?? 0) + 1;
      return acc;
    }, {}),
  },
  items: unique,
};

await mkdir(join(OUT, 'data'), { recursive: true });
await writeFile(join(OUT, 'data', `items-${TODAY}.json`), JSON.stringify(payload, null, 2));

const voicePeople = [...xPlan.values()]
  .filter((entry) => entry.person && entry.posts?.length)
  .map((entry) => ({
    handle: entry.handle,
    name: entry.person.name,
    focus: entry.person.focus,
    topics: [...entry.topics],
    posts: entry.posts.map((post) => ({
      id: post.id, text: post.text, publishedAt: post.publishedAt, url: post.url,
    })),
  }));

if (voicePeople.length > 0) {
  await writeFile(
    join(OUT, 'data', `voices-${TODAY}.json`),
    JSON.stringify({ generatedAt: new Date().toISOString(), day: TODAY, people: voicePeople }, null, 2),
  );
  console.error(`[tech-radar] 大V ${voicePeople.length} 人 → data/voices-${TODAY}.json`);
}

if (!flag('dry')) {
  const nextSeen = { ...seen };
  for (const item of unique) nextSeen[item.id] = TODAY;
  const cutoffDay = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  for (const [id, date] of Object.entries(nextSeen)) if (date < cutoffDay) delete nextSeen[id];
  await mkdir(join(OUT, 'state'), { recursive: true });
  await writeFile(join(OUT, 'state', 'seen.json'), JSON.stringify(nextSeen, null, 2));
}

console.error(
  `\n[tech-radar] 原始 ${all.length} 条 → 相关 ${tagged.length} 条 → 新条目 ${fresh.length} 条 → 保留 ${unique.length} 条`,
);
for (const topic of topicStats) {
  console.error(`[tech-radar]   ${topic.emoji ?? ''}${topic.name}  ${topic.count} 条`);
}
console.error(`[tech-radar] 写入 data/items-${TODAY}.json\n`);
