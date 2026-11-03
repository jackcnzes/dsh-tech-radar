/**
 * 把各来源的原始响应解析成统一的 RadarItem。
 *
 * RadarItem = {
 *   id: string,          // 内容哈希，去重键
 *   source: 'x'|'hn'|'github'|'arxiv'|'rss',
 *   title: string,
 *   text: string,
 *   url: string,
 *   author?: string,
 *   publishedAt?: string, // ISO
 *   metrics?: Record<string, number>,
 * }
 */

import { contentId, stripHtml, truncate } from './http.mjs';

/**
 * RSS/Atom 里大量字段被 <![CDATA[...]]> 包着。
 * 必须先剥掉这层再 stripHtml —— 否则 `<![CDATA[标题]]>` 会被当成一个 HTML 标签整段吃掉。
 */
function decodeXmlText(raw) {
  return stripHtml(
    String(raw ?? '')
      .replace(/<!\[CDATA\[/g, '')
      .replace(/\]\]>/g, ''),
  );
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * 从推文正文里抠出 "Oct 23" 这类日期。
 *
 * X 的时间线快照没有结构化时间戳，但转推/引用的正文开头会带原始日期。
 * 不解析的话，`--all` 每天都会把两周前的推文当成新的收一遍；而且浏览量、
 * 点赞数的变化会让内容哈希失效，去重也拦不住。
 * @returns {string|undefined} ISO 时间，取当天中午 UTC，避免跨时区掉出窗口
 */
function extractTweetDate(text) {
  const match = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})\b/i);
  if (!match) return undefined;

  const month = MONTHS[match[1].toLowerCase().slice(0, 3)];
  const day = Number(match[2]);
  if (month === undefined || day < 1 || day > 31) return undefined;

  const now = new Date();
  let year = now.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month, day, 12));
  // 12 月看到 "Jan 2" 时，指的是明年/去年的 1 月，回退一年
  if (candidate.getTime() > now.getTime() + 26 * 3_600_000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month, day, 12));
  }
  return candidate.toISOString();
}

/**
 * 解析 r.jina.ai 渲染后的 X 账号时间线 Markdown。
 *
 * 实际形态（r.jina.ai 的 markdown 转换结果）：
 *   *   [![Image 4: @OpenAI](...)](https://x.com/OpenAI) 正文…
 *   *   Pinned
 *   *   [![Image 5: @METR_Evals](...)](https://x.com/METR_Evals) 引用…
 *
 * 注意：jina 的输出不含单条推文的 status id 和时间戳，所以只能靠正文哈希去重。
 */
export function parseXTimeline(markdown, handle, max) {
  const body = markdown.includes('Markdown Content:')
    ? markdown.slice(markdown.indexOf('Markdown Content:') + 'Markdown Content:'.length)
    : markdown;

  const segments = [];
  let current = null;

  for (const line of body.split('\n')) {
    if (/^\s*\*\s{2,}/.test(line) || /^\s*\*\s+\S/.test(line)) {
      if (current !== null) segments.push(current);
      current = line.replace(/^\s*\*\s+/, '');
      continue;
    }
    if (current !== null) current += `\n${line}`;
  }
  if (current !== null) segments.push(current);

  const items = [];
  for (const raw of segments) {
    const text = cleanMarkdown(raw).replace(/^Pinned\s+/i, '');
    if (text.length < 24) continue;
    if (/^(pinned|show more|replies|·|ad)$/i.test(text)) continue;
    // 正文被截断的转推/引用块通常以 "Readers added context" 收尾，直接切掉
    const cut = text.split(/Readers added context/i)[0].trim();
    if (cut.length < 24) continue;

    items.push({
      id: contentId(cut),
      source: 'x',
      author: `@${handle}`,
      title: truncate(cut, 90),
      text: truncate(cut, 600),
      url: `https://x.com/${handle}`,
      publishedAt: extractTweetDate(cut),
      metrics: {},
    });
  }

  // 同一条推文可能在置顶和时间线里重复出现
  const seen = new Set();
  const unique = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  return unique.slice(0, max);
}

function cleanMarkdown(raw) {
  return String(raw)
    // 整块删掉图片
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    // [文本](链接) -> 文本
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 残留的 blob: 与转义
    .replace(/\(blob:[^)]*\)/g, ' ')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hacker News：Algolia 返回结构化 JSON，这是最省心的来源。 */
export function parseHackerNews(payload, now = Date.now()) {
  return (payload.hits ?? [])
    .filter((hit) => hit.title && (hit.points ?? 0) > 0)
    .map((hit) => ({
      id: contentId(`hn ${hit.title}`),
      source: 'hn',
      title: hit.title,
      text: truncate(hit.story_text ?? hit.comment_text ?? hit.title, 400),
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      author: hit.author,
      publishedAt: hit.created_at,
      metrics: {
        points: hit.points ?? 0,
        comments: hit.num_comments ?? 0,
        ageHours: Math.round((now - new Date(hit.created_at).getTime()) / 3_600_000),
        hnId: hit.objectID,
      },
    }));
}

/** GitHub Trending：HTML 里每行 repo 是一个 <article class="Box-row">。 */
export function parseGitHubTrending(html, limit) {
  const articles = html.split('<article').slice(1);
  const items = [];

  for (const article of articles) {
    const repo = article.match(/<h2[^>]*>[\s\S]*?href="\/([^"]+\/[^"]+?)"/);
    if (!repo) continue;
    const fullName = repo[1].replace(/\/$/, '');

    const description = article.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const stars = article.match(/([\d,]+)\s*stars\s*today/i);
    const totalStars = article.match(/href="\/[^"]+\/stargazers"[^>]*>[\s\S]*?([\d,]+)\s*<\/a>/);
    const language = article.match(/itemprop="programmingLanguage">([^<]+)</);

    items.push({
      id: contentId(`github ${fullName}`),
      source: 'github',
      title: fullName,
      text: `${fullName}${description ? ` — ${stripHtml(description[1])}` : ''}`,
      url: `https://github.com/${fullName}`,
      author: fullName.split('/')[0],
      publishedAt: undefined,
      metrics: {
        starsToday: stars ? Number(stars[1].replace(/,/g, '')) : 0,
        stars: totalStars ? Number(totalStars[1].replace(/,/g, '')) : 0,
        ...(language ? { language: 0 } : {}),
      },
      tags: language ? [language[1].trim()] : [],
    });
  }

  return items.slice(0, limit);
}

/**
 * GitHub Search API 兜底：github.com 网页不可达时用"最近 7 天新建、star 最多"近似 trending。
 * 注意 publishedAt 故意留空——这些仓库是"当下在涨"，不是"今天发布的新闻"，
 * 若填 created_at，排序里的时间衰减会把它们全部归零。
 */
export function parseGitHubSearch(payload, limit) {
  return (payload.items ?? []).slice(0, limit).map((repo) => ({
    id: contentId(`github ${repo.full_name}`),
    source: 'github',
    title: repo.full_name,
    text: `${repo.full_name}${repo.description ? ` — ${repo.description}` : ''}`,
    url: repo.html_url,
    author: repo.owner?.login,
    publishedAt: undefined,
    metrics: {
      stars: repo.stargazers_count ?? 0,
      weight: 1.2,
      createdDaysAgo: Math.round((Date.now() - new Date(repo.created_at).getTime()) / 86_400_000),
    },
    tags: repo.language ? [repo.language] : [],
  }));
}

/** arXiv Atom 响应。 */
export function parseArxiv(xml, limit) {
  const entries = xml.split('<entry>').slice(1);
  const items = [];

  for (const entry of entries.slice(0, limit)) {
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const summary = entry.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    const id = entry.match(/<id>([^<]+)<\/id>/)?.[1];
    if (!title) continue;

    const cleanTitle = decodeXmlText(title);
    items.push({
      id: contentId(`arxiv ${cleanTitle}`),
      source: 'arxiv',
      title: cleanTitle,
      text: truncate(decodeXmlText(summary ?? cleanTitle), 500),
      url: id ?? 'https://arxiv.org',
      author: entry.match(/<name>([^<]+)<\/name>/)?.[1] ?? 'arXiv',
      publishedAt: published,
      metrics: {},
    });
  }

  return items;
}

/**
 * 通用 RSS / Atom。
 * 只解析前 80 条：多数 feed 会返回全部历史（OpenAI 的就有 1300+ 条），
 * 按发布时间倒序排列，前 80 条足够覆盖 30 小时窗口。
 */
export function parseFeed(xml, feedName, weight = 1) {
  const blocks = [
    ...xml.split('<item>').slice(1),
    ...xml.split('<entry>').slice(1),
  ].slice(0, 80);

  const items = [];
  for (const block of blocks) {
    const title = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1];
    const link =
      block.match(/<link[^>]*>(?:<!\[CDATA\[)?([^<\]]+)/)?.[1] ??
      block.match(/<link[^>]*href="([^"]+)"/)?.[1];
    const description =
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/)?.[1] ??
      block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ??
      block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1];
    const published =
      block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1] ??
      block.match(/<published>([^<]+)<\/published>/)?.[1] ??
      block.match(/<updated>([^<]+)<\/updated>/)?.[1];

    if (!title) continue;
    const cleanTitle = decodeXmlText(title).trim();
    if (!cleanTitle) continue;

    items.push({
      id: contentId(`${feedName} ${cleanTitle}`),
      source: 'rss',
      title: cleanTitle,
      text: truncate(decodeXmlText(description ?? cleanTitle), 400),
      url: link ? String(link).trim() : '',
      author: feedName,
      publishedAt: published ? new Date(published).toISOString() : undefined,
      metrics: { weight },
      tags: [feedName],
    });
  }

  return items;
}

/**
 * Telegram 公开频道预览（t.me/s/<channel>）。
 * 每个消息在 <div class="tgme_widget_message_wrap" data-post="channel/123"> 里，
 * 正文在 tgme_widget_message_text，时间在 <time datetime>。
 */
export function parseTelegram(html, channel) {
  const blocks = html.split('tgme_widget_message_wrap').slice(1);
  const items = [];

  for (const block of blocks) {
    const post = block.match(/data-post="([^"]+)"/)?.[1];
    const raw = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const time = block.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    const text = raw ? stripHtml(raw) : '';
    if (!post || text.length < 20) continue;

    items.push({
      id: contentId(`tg ${post}`),
      source: 'telegram',
      title: truncate(text, 90),
      text: truncate(text, 600),
      url: `https://t.me/${post}`,
      author: `@${channel}`,
      publishedAt: time ? new Date(time).toISOString() : undefined,
      metrics: {},
    });
  }

  return items;
}

/** Bilibili 热门排行：JSON，字段稳定。 */
export function parseBilibili(payload, limit) {
  return (payload?.data?.list ?? []).slice(0, limit).map((video) => ({
    id: contentId(`bili ${video.bvid}`),
    source: 'bilibili',
    title: video.title,
    text: truncate(video.desc ?? video.title, 400),
    url: `https://www.bilibili.com/video/${video.bvid}`,
    author: video.owner?.name ?? 'Bilibili',
    publishedAt: video.pubdate ? new Date(video.pubdate * 1000).toISOString() : undefined,
    metrics: { views: video.stat?.view ?? 0, weight: 1.1 },
  }));
}

/**
 * GitHub 榜单过滤。
 *
 * 榜单每天都会被污染：盗版/DRM 绕过、固件解锁、玄学排盘、直播源……
 * 但「安全」这个词不能一刀切——`security-audit-skill`（防御）和
 * `php2shell-poc`（攻击武器）都是高星安全项目，处理方式应该相反。
 *
 * 规则：
 *   1. 命中 filter.block  → 丢弃（可被 filter.allow 豁免）
 *   2. 命中 filter.exploit.match → 丢弃，除非同时命中 exploit.rescue（防御侧工具）
 *
 * @param {Array<object>} items parseGitHubTrending / parseGitHubSearch 的产物
 * @param {{block?: string[], allow?: string[], exploit?: {match?: string[], rescue?: string[]}}} [filter]
 * @returns {{kept: object[], dropped: Array<{title: string, reason: string}>}}
 */
export function filterGitHub(items, filter = {}) {
  const block = (filter.block ?? []).map((w) => w.toLowerCase());
  const allow = (filter.allow ?? []).map((w) => w.toLowerCase());
  const exploitMatch = (filter.exploit?.match ?? []).map((w) => w.toLowerCase());
  const exploitRescue = (filter.exploit?.rescue ?? []).map((w) => w.toLowerCase());

  const kept = [];
  const dropped = [];

  /**
   * 子串匹配会把 `mattpocock/skills` 里的 "poc" 当成漏洞利用（pocock ⊃ poc）。
   * 英文词按词边界匹配，中文词仍用子串（中文没有空格分词）。
   */
  const hits = (haystack, word) => {
    if (/[\u4e00-\u9fff]/.test(word)) return haystack.includes(word);
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 允许常见的复数/后缀（jailbreak → jailbreaks，crack → cracked），
    // 但要求词尾不再接其他字母，避免 poc 命中 pocock。
    return new RegExp(`(^|[^a-z0-9])${escaped}(s|ed|es)?([^a-z0-9]|$)`, 'i').test(haystack);
  };

  for (const item of items) {
    const haystack = `${item.title} ${item.text ?? ''}`.toLowerCase();

    const blocked = block.find((word) => hits(haystack, word));
    if (blocked) {
      const rescued = allow.find((word) => hits(haystack, word));
      if (!rescued) {
        dropped.push({ title: item.title, reason: `block:${blocked}` });
        continue;
      }
    }

    const exploitHit = exploitMatch.find((word) => hits(haystack, word));
    if (exploitHit) {
      // 豁免词只看仓库名：描述里出现 "detection rules" 并不代表它是防御工具，
      // 攻击型 PoC 也常在描述里附检测规则。
      const nameOnly = item.title.toLowerCase();
      const rescued = exploitRescue.find((word) => hits(nameOnly, word));
      if (!rescued) {
        dropped.push({ title: item.title, reason: `exploit:${exploitHit}` });
        continue;
      }
    }

    kept.push(item);
  }

  return { kept, dropped };
}

/**
 * X 官方 syndication 时间线（syndication.twitter.com）。
 *
 * 这是 X 给嵌入式时间线用的公开接口，返回完整结构化 JSON：
 * 真实 created_at、id_str、permalink、点赞/转发数。
 * 相比第三方渲染（r.jina.ai），它免费、无需 key、且能给出单条推文链接。
 *
 * 结构：/props/pageProps/timeline/entries[]/content/tweet
 * @param {string} htmlOrJson 页面 HTML（内含 __NEXT_DATA__）或直接 JSON
 * @param {string} handle 账号名
 * @param {number} max 最多返回条数
 */
export function parseXSyndication(htmlOrJson, handle, max = 8) {
  let data;
  const match = String(htmlOrJson).match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  try {
    data = match ? JSON.parse(match[1]) : JSON.parse(htmlOrJson);
  } catch {
    return [];
  }

  const entries = data?.props?.pageProps?.timeline?.entries ?? [];
  const items = [];

  for (const entry of entries) {
    const tweet = entry?.content?.tweet;
    if (!tweet?.full_text) continue;
    // 跳过纯转推的空壳
    if (!tweet.full_text.trim()) continue;

    const permalink = tweet.permalink
      ? `https://x.com${tweet.permalink.startsWith('/') ? '' : '/'}${tweet.permalink}`
      : `https://x.com/${handle}`;

    items.push({
      id: contentId(`x ${tweet.id_str ?? tweet.full_text}`),
      source: 'x',
      author: `@${tweet.user?.screen_name ?? handle}`,
      title: truncate(tweet.full_text.replace(/\s+/g, ' ').trim(), 90),
      text: truncate(tweet.full_text.trim(), 600),
      // 与 Jina 方案最大的差别：这里能拿到单条推文的永久链接
      url: permalink,
      publishedAt: tweet.created_at ? new Date(tweet.created_at).toISOString() : undefined,
      metrics: {
        likes: tweet.favorite_count ?? 0,
        retweets: tweet.retweet_count ?? 0,
        replies: tweet.reply_count ?? 0,
      },
    });
  }

  return items.slice(0, max);
}

/**
 * 微博热搜（weibo.com/ajax/side/hotSearch）。
 *
 * 必须带 Referer: https://weibo.com/ 否则返回 403。
 * 返回 data.realtime[]，每项有 word / num（热度）/ label_name（新/沸/热）。
 * @param {{data?: {realtime?: Array<object>}}} payload
 * @param {string[]} [keywords] 命中则保留（大小写不敏感）；为空则全收
 * @param {number} [limit]
 */
export function parseWeiboHotSearch(payload, keywords = [], limit = 20) {
  const list = payload?.data?.realtime ?? [];
  const lower = keywords.map((k) => k.toLowerCase());

  const items = [];
  for (const entry of list) {
    const word = String(entry.word ?? '').trim();
    if (!word) continue;
    if (lower.length > 0 && !lower.some((k) => word.toLowerCase().includes(k))) continue;

    const heat = Number(entry.num) || 0;
    items.push({
      id: contentId(`weibo ${word}`),
      source: 'weibo',
      title: word,
      text: `${word}${entry.label_name ? `（${entry.label_name}）` : ''} 热度 ${heat.toLocaleString('en-US')}`,
      // 微博搜索页需要登录，用热榜页作稳定入口
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(`#${word}#`)}`,
      author: '微博热搜',
      publishedAt: undefined,
      metrics: { heat },
    });
    if (items.length >= limit) break;
  }
  return items;
}
