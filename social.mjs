#!/usr/bin/env node
/**
 * 社媒热点快照：只扫 X / Instagram / Facebook 的热点话题，各取 10 条。
 *
 *   node social.mjs                 # 默认各 10 条
 *   node social.mjs --per=10
 *
 * 实测约束（2026-10）：
 *   X         搜索页永远跳登录，改用 trends24.in 的公开镜像抓热搜榜
 *   Instagram 未登录只返回登录页外壳，无帖子数据 → 只能报"不可用"
 *   Facebook  302 到登录页，无公开读取接口 → 只能报"不可用"
 *
 * 产物：<outputDir>/data/social-<day>.json
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getText, stripHtml } from './lib/http.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const per = Number(argv.find((a) => a.startsWith('--per='))?.split('=')[1] ?? 10);

const config = JSON.parse(await readFile(join(CODE_ROOT, 'config.json'), 'utf8'));
const OUT = resolve(CODE_ROOT, config.outputDir ?? '../tech-radar');

const today = (() => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(new Date());
  const pick = (t) => parts.find((p) => p.type === t)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
})();

/**
 * X 热搜：trends24.in 镜像的 X 趋势榜。
 * 页面里每个条目是 <li><a href="...">#Tag</a><span class="tweet-count">12K</span></li>
 */
async function fetchXTrends() {
  const html = await getText('https://trends24.in/united-states/', { timeoutMs: 25_000, retries: 1 });
  const blocks = html.match(/<li[^>]*>[\s\S]*?<\/li>/g) ?? [];
  const seen = new Set();
  const trends = [];

  for (const block of blocks) {
    const link = block.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const name = stripHtml(link[2]).trim();
    if (!name || name.length > 60) continue;
    if (/^new$|checkout|trends24/i.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const count = block.match(/class="tweet-count"[^>]*>([^<]*)</)?.[1]?.trim() ?? '';
    trends.push({ name, count });
    if (trends.length >= per) break;
  }
  return trends;
}

const sources = [];

try {
  const trends = await fetchXTrends();
  sources.push({ id: 'x', name: 'X 热搜（经 trends24 镜像）', status: 'ok', trends });
} catch (error) {
  sources.push({ id: 'x', name: 'X 热搜', status: 'error', note: error.message, trends: [] });
}

// 这两个不是"没实现"，是平台侧确实拿不到，如实标注
sources.push({
  id: 'instagram',
  name: 'Instagram',
  status: 'blocked',
  note: '未登录只返回登录页外壳（实测 513KB 但零帖子数据），无公开读取接口',
  trends: [],
});
sources.push({
  id: 'facebook',
  name: 'Facebook',
  status: 'blocked',
  note: '公开主页 302 跳转登录页，无公开读取接口',
  trends: [],
});

const payload = {
  generatedAt: new Date().toISOString(),
  day: today,
  perSource: per,
  sources,
};

const { mkdir, writeFile } = await import('node:fs/promises');
await mkdir(join(OUT, 'data'), { recursive: true });
await writeFile(join(OUT, 'data', `social-${today}.json`), JSON.stringify(payload, null, 2));

for (const source of sources) {
  const tag = source.status === 'ok' ? '✓' : '✗';
  console.error(`${tag} ${source.name.padEnd(28)} ${source.trends.length} 条${source.note ? `  (${source.note})` : ''}`);
}
console.error(`\n写入 ${OUT}/data/social-${today}.json`);
