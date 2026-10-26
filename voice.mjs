#!/usr/bin/env node
/**
 * 查看某位技术大V最近在说什么。
 *
 *   node voice.mjs karpathy          # 打印这个人的近期帖子
 *   node voice.mjs --all             # 所有人
 *   node voice.mjs --list            # 看主题包里都配了谁
 *   node voice.mjs --topic=tech --list
 *
 * 大V名单定义在 topics/<id>.json 的 influencers 字段。
 * 帖子数据来自 <outputDir>/data/voices-<day>.json（由 collect.mjs 生成）。
 * 本脚本只负责取数与排版，"这些话意味着什么"由 agent 读完后总结。
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
const target = argv.find((arg) => !arg.startsWith('--'));

const argValue = (name) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const config = JSON.parse(await readFile(join(CODE_ROOT, 'config.json'), 'utf8'));
const OUT = resolve(CODE_ROOT, config.outputDir ?? '../tech-radar');

/** 从主题包里汇总大V，按 handle 去重，保留其所属主题。 */
async function loadPeople() {
  const files = (await readdir(join(CODE_ROOT, 'topics'))).filter((name) => name.endsWith('.json'));
  const wanted = argValue('topic');
  const byHandle = new Map();

  for (const file of files) {
    const pack = JSON.parse(await readFile(join(CODE_ROOT, 'topics', file), 'utf8'));
    if (wanted && pack.id !== wanted) continue;
    for (const person of pack.influencers ?? []) {
      const entry = byHandle.get(person.handle) ?? { ...person, topics: [] };
      entry.topics.push(pack.id);
      byHandle.set(person.handle, entry);
    }
  }
  return [...byHandle.values()];
}

const people = await loadPeople();

if (flags.has('--list')) {
  if (people.length === 0) {
    console.log('没有配置任何大V。在 topics/<id>.json 的 influencers 里加。');
    process.exit(0);
  }
  console.log(`配置中的大V（${people.length} 人）：`);
  for (const person of people) {
    console.log(`  @${person.handle.padEnd(14)} ${person.name.padEnd(18)} ${person.focus ?? ''}  [${person.topics.join(',')}]`);
  }
  process.exit(0);
}

const today = (() => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
})();

let bundle;
try {
  bundle = JSON.parse(await readFile(join(OUT, 'data', `voices-${today}.json`), 'utf8'));
} catch {
  console.error(`[voice] 没有找到 ${OUT}/data/voices-${today}.json，先跑一次：node collect.mjs --all`);
  process.exit(1);
}

const selected = flags.has('--all')
  ? bundle.people
  : bundle.people.filter((person) => person.handle.toLowerCase() === String(target ?? '').toLowerCase());

if (selected.length === 0) {
  console.error(`[voice] 没找到 "${target}"。可用：${bundle.people.map((p) => '@' + p.handle).join(', ')}`);
  process.exit(1);
}

if (flags.has('--json')) {
  console.log(JSON.stringify(selected, null, 2));
  process.exit(0);
}

for (const person of selected) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`@${person.handle}  ·  ${person.name}  ·  ${person.focus ?? ''}`);
  console.log(`共 ${person.posts.length} 条近期帖子`);
  console.log('='.repeat(72));

  if (person.posts.length === 0) {
    console.log('（该账号本次没有解析到帖子，可能被限流或页面结构变化）');
    continue;
  }

  person.posts.forEach((post, index) => {
    const when = post.publishedAt ? post.publishedAt.slice(0, 10) : '日期未知';
    console.log(`\n[${index + 1}] ${when}`);
    console.log(post.text);
  });
}

console.log('\n---');
console.log('提示：把上面的帖子读完，总结出「TA 最近关注什么 / 观点有什么变化 / 有没有可执行的信息」。');
