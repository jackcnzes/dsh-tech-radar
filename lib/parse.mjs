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
