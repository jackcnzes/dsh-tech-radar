#!/usr/bin/env node
/**
 * 把简报推送到 IM。
 *
 *   node push.mjs --file briefings/2026-10-23.md
 *   node push.mjs --file briefings/2026-10-23.md --dry-run   # 只打印 payload，不发请求
 *
 * 支持 feishu / dingtalk / slack / telegram / generic，由 config.json 的 im.kind 决定。
 */

import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { postJson, sleep } from './lib/http.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};
const dryRun = argv.includes('--dry-run');

const config = JSON.parse(await readFile(join(CODE_ROOT, 'config.json'), 'utf8'));
const OUT = resolve(CODE_ROOT, config.outputDir ?? '../tech-radar');
const im = config.im ?? {};

// 环境变量优先：webhook 属于密钥，放进 shell 环境比写进 config.json 更安全
if (process.env.IM_KIND) im.kind = process.env.IM_KIND;
if (process.env.IM_WEBHOOK) im.webhook = process.env.IM_WEBHOOK;
if (process.env.IM_SECRET) im.secret = process.env.IM_SECRET;
if (process.env.TELEGRAM_TOKEN) im.telegram = { ...im.telegram, token: process.env.TELEGRAM_TOKEN };
if (process.env.TELEGRAM_CHAT_ID) im.telegram = { ...im.telegram, chatId: process.env.TELEGRAM_CHAT_ID };

const file = valueOf('file') ?? (() => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return join(OUT, 'briefings', `${pick('year')}-${pick('month')}-${pick('day')}.md`);
})();

const markdown = await readFile(file, 'utf8');
const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '技术热点日报';

/** 飞书自定义机器人：优先用互动卡片，超长时退化成纯文本。 */
function feishuPayload() {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      { tag: 'markdown', content: markdown },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `tech-radar · ${new Date().toISOString()}` }],
      },
    ],
  };
  if (markdown.length > 25_000) {
    return { msg_type: 'text', content: { text: `${title}\n\n${markdown}`.slice(0, 28_000) } };
  }
  return { msg_type: 'interactive', card };
}

function dingtalkPayload(secret) {
  const payload = {
    msgtype: 'markdown',
    markdown: { title, text: `### ${title}\n\n${markdown}` },
  };
  if (!secret) return { url: im.webhook, payload };

  const timestamp = Date.now();
  const sign = createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
  const url = `${im.webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
  return { url, payload };
}

const builders = {
  feishu: () => ({ url: im.webhook, payload: feishuPayload() }),
  dingtalk: () => dingtalkPayload(im.secret),
  slack: () => ({
    url: im.webhook,
    payload: {
      text: title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
        { type: 'section', text: { type: 'mrkdwn', text: markdown.slice(0, 2900) } },
      ],
    },
  }),
  telegram: () => ({
    url: `https://api.telegram.org/bot${im.telegram?.token}/sendMessage`,
    payload: {
      chat_id: im.telegram?.chatId,
      text: `${title}\n\n${markdown}`.slice(0, 4000),
      disable_web_page_preview: true,
    },
  }),
  generic: () => ({ url: im.webhook, payload: { title, text: markdown } }),
};

const build = builders[im.kind];
if (!build) {
  console.error(`[push] 未知的 im.kind: ${im.kind}`);
  process.exit(1);
}

const { url, payload } = build();
const body = JSON.stringify(payload);

if (dryRun) {
  console.log(JSON.stringify({ kind: im.kind, url: url || '(未配置)', payload, bytes: body.length }, null, 2));
  process.exit(0);
}

if (!url) {
  console.error('[push] config.json 里 im.webhook 为空，已跳过推送。');
  console.error(`[push] 简报文件：${file}`);
  process.exit(0);
}

// IM 平台常有频率限制，退避重试三次
let lastError;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const response = await postJson(url, payload, { timeoutMs: 30_000, retries: 0 });
    const ok = !/"code"\s*:\s*[1-9]/.test(response) && !/"errcode"\s*:\s*[1-9]/.test(response);
    console.log(`[push] ${im.kind} → ${response.slice(0, 200)}`);
    if (!ok) process.exitCode = 1;
    break;
  } catch (error) {
    lastError = error;
    await sleep(2000 * (attempt + 1));
  }
}
if (lastError && process.exitCode !== 0 && process.exitCode !== 1) {
  console.error(`[push] 推送失败: ${lastError.message}`);
  process.exit(1);
}
