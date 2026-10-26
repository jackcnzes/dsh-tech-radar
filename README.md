# 科技热点雷达 · tech-radar

[English](README.en.md) ｜ 中文

## 这是什么

把 X、RSS、Hacker News、GitHub、arXiv、Telegram 上的公开信号，自动收成一份中文日报，推送到 IM。可以换主题（技术 / 体育 / 汽车 / 财经 / 游戏 / 科学），也可以盯着某几个技术大V看他们最近在说什么。

**它不是什么**：不是全站热榜爬虫，也不是舆情监控。只读公开内容，不登录、不绕过任何访问控制。

## 核心能力

- **多主题**：一个主题一个 JSON 文件，随时切换，一次可跑多个并合并成多栏目简报。
- **大V追踪**：按人聚合最近帖子，输出「TA 最近关注什么 / 观点有什么变化」。
- **跨日去重**：URL 与标题双轨比对，避免同一件事连写两天。
- **两种模式**：增量（只出上次之后的新内容）与全量（按时间窗取，日报用这个）。
- **多端推送**：飞书 / 钉钉 / Slack / Telegram / 任意 webhook。
- **GUI 配置**：可安装的 Harness 插件，在设置页里点选主题与数据来源。

## 数据源实测

这一节是项目的起点：能不能做，只取决于数据拿不拿得到。下表是 2026-10 的实测结果，不是推测。

| 来源 | 状态 | 方式 | 实测结果 |
|---|---|---|---|
| RSS / Atom | ✅ 可用 | 直连订阅源 | 最稳的一类，覆盖多数媒体与博客 |
| Hacker News | ✅ 可用 | Algolia API | 结构化 JSON，一次可取 30 条 |
| GitHub Trending | ✅ 可用 | 网页抓取 | 失败时自动降级到 Search API |
| arXiv | ✅ 可用 | 官方 Atom API | 按分类与提交时间排序 |
| Telegram 频道 | ✅ 可用 | `t.me/s/<channel>` | 公开预览页，实测 17 条 |
| X / Twitter | ⚠️ 需代理 | `r.jina.ai` 渲染 | 代理关闭即不可达；搜索页永远要登录 |
| Bilibili 排行 | ❌ 不可用 | 排行榜 API | 风控返回 `-352`，需 Cookie |
| 微博 | ❌ 不可用 | 热搜接口 | 需登录态，实测 403 |
| Instagram | ❌ 不可用 | 公开主页 | 未登录一律 302 到登录页，零帖子数据 |
| Facebook | ❌ 不可用 | 公开主页 | 需登录，无公开读取接口 |
| 抖音 | ❌ 不可用 | — | 无公开 API，需签名与登录态 |

两个必须知道的坑：

1. **X 只能按账号抓，不能按话题抓。** 搜索页要登录，所以「X 上今天什么最热」拿不到。替代方案是维护一份高质量账号名单，用 HN / GitHub 的客观热度做交叉验证。
2. **本机抓取必须走子进程。** 当 DNS 是 fake-IP 模式（`x.com → 198.18.0.57`）时，Harness 自带的 `web_fetch` 会把该地址判定为非公网并拒绝，而 `curl` / Node `fetch` 走系统代理是通的。所以采集层是独立脚本，不依赖 agent 的抓取工具。

## 架构

```
X · RSS · HN · GitHub · arXiv · Telegram
              │
              │  collect.mjs
              │  并发采集 → 归一化 → 相关性过滤 → 跨日去重
              ▼
   <outputDir>/data/items-YYYY-MM-DD.json
              │
              │  Agent + PLAYBOOK.md
              │  选题 → 主题聚类 → 写事实与判断
              ▼
   <outputDir>/briefings/YYYY-MM-DD.md
              │
              │  push.mjs
              ▼
   飞书 / 钉钉 / Slack / Telegram
```

**设计原则：确定性归脚本，判断力归模型。** 采集、去重、过滤、推送都是纯脚本，便宜、可复现、失败可定位；只有「选哪几条、怎么解读」交给 LLM。

## 目录结构

```
dsh-tech-radar/            代码与配置（可安装的插件包）
├── index.js               Host 半边：四个 HTTP 接口
├── client.js              Client 半边：设置页面板
├── collect.mjs            采集入口
├── push.mjs               推送入口
├── voice.mjs              查看大V最近帖子
├── lib/
│   ├── http.mjs           带超时/重试的 fetch、内容哈希
│   └── parse.mjs          各来源解析器
├── topics/                主题包（6 个）
├── settings/              GUI 写入的开关
│   ├── topics.json
│   └── sources.json
├── config.json            全局配置
├── cordis.patch.yml       插件注册（无绝对路径）
├── PLAYBOOK.md            给 agent 的每日执行手册
├── README.md              本文件
└── tools/mock-im.mjs      本地 webhook 联调工具

tech-radar/                运行产物（不进插件包）
├── data/                  采集结果与 voices
├── briefings/             每日简报
└── state/seen.json        增量模式的已读记录
```

代码与产物分开，是为了不把每天增长的采集结果塞进一个可安装、可发布的包里。产物位置由 `config.json` 的 `outputDir` 决定，默认 `../tech-radar`。

## 快速开始

```bash
cd ~/personal/git/dsh-tech-radar

# 1. 采集（默认读 GUI 选择的主题）
node collect.mjs --all

# 2. 看结果
python3 -m json.tool ../tech-radar/data/items-$(date +%F).json | head -40

# 3. 看简报（由 agent 按 PLAYBOOK 写出后）
cat ../tech-radar/briefings/$(date +%F).md

# 4. 推送
IM_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx' \
  node push.mjs --file ../tech-radar/briefings/$(date +%F).md
```

## 主题包

每个主题是 `topics/<id>.json` 一个文件：

```json
{
  "id": "sports",
  "name": "体育",
  "emoji": "⚽",
  "description": "足球 / 篮球 / 赛车",
  "keywords": ["nba", "f1", "转会", "季后赛"],
  "filterSources": ["rss"],
  "x": { "handles": ["ESPN", "NBA", "F1"] },
  "influencers": [{ "handle": "FabrizioRomano", "name": "Fabrizio Romano", "focus": "转会" }],
  "rss": [{ "name": "Yahoo Sports", "url": "https://sports.yahoo.com/rss/" }],
  "telegram": [],
  "hackernews": { "enabled": false },
  "github": { "enabled": false },
  "arxiv": { "enabled": false }
}
```

字段说明：

- `keywords`：命中即视为相关。只对 `filterSources` 里的来源生效（默认 `hn`、`rss`、`bilibili`），X / GitHub / arXiv / Telegram 属于白名单来源，默认放行。
- `x.handles`：机构账号，进热点池。
- `influencers`：个人账号，进「大V在说什么」栏目；同一个 handle 出现在多个主题里会合并。
- `telegram`：频道名（`t.me/s/` 后面的部分）。
- `hackernews` / `github` / `arxiv`：设 `enabled: false` 可让该主题跳过这些来源。

内置 6 个主题：`tech`、`sports`、`auto`、`finance`、`games`、`science`。

**新增主题** = 加一个 JSON 文件，不用改代码；重开设置页就会出现在下拉里。

## 大V追踪

大V名单在主题包的 `influencers` 里，采集时按人聚合：

```bash
node voice.mjs --list             # 看配置了谁
node voice.mjs --topic=tech --list
node voice.mjs karpathy           # 看某人最近帖子
node voice.mjs --all
node voice.mjs --json
```

设计取舍：**大V数据不参与「是否新」的过滤**。衡量的是「这个人最近在说什么」，不是「今天有什么新东西」——同一个人的时间线一周不变很正常，但这不影响判断他的立场。

`voice.mjs` 只负责取数与排版，「这些话意味着什么」由 agent 读完再总结，这是刻意的分工。

## Harness 插件

`dsh-tech-radar/` 同时是一个可安装的 Cordis 插件。装好后 **设置 → 插件 → 热点雷达** 是一个页面，顶部两个子菜单：

- **热点主题**：待扫描列表 + 下拉添加 / 移除
- **热点来源**：11 个来源的状态与开关

四个接口，全部先过 `ctx.connection.requestRejection()`，与平台 `/api` 共用同一套 Host/Origin 与浏览器凭据校验：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/tech-radar/state` | 主题列表与当前启用项 |
| POST | `/tech-radar/activate` | 写入 `settings/topics.json` |
| GET | `/tech-radar/sources` | 来源列表与开关状态 |
| POST | `/tech-radar/sources/toggle` | 写入 `settings/sources.json` |

插件路径由 `import.meta.url` 推导，`cordis.patch.yml` 里没有绝对路径——**整个目录搬家不用改配置**。只有移动或重命名插件目录本身才需要重新 `install_bundle`。

## 命令行参考

| 命令 | 作用 |
|---|---|
| `node collect.mjs` | 增量模式：只输出上次运行之后的新内容 |
| `node collect.mjs --all` | 全量模式：按 `lookbackHours` 取，**日报用这个** |
| `node collect.mjs --topics=tech,auto` | 临时指定主题，覆盖 GUI 与 config |
| `node collect.mjs --source=rss,hn` | 只跑指定来源 |
| `node collect.mjs --dry` | 不更新已读状态 |
| `node push.mjs --file <path>` | 推送指定简报 |
| `node push.mjs --dry-run` | 只打印 payload |
| `node voice.mjs [handle]` | 看某人最近帖子 |
| `node tools/mock-im.mjs 8899` | 本地起一个 webhook 接收器 |

## 配置

`config.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `outputDir` | `../tech-radar` | 产物目录，相对包目录 |
| `activeTopics` | `["tech"]` | GUI 没写过时的默认主题 |
| `briefing.lookbackHours` | `24` | 时间窗 |
| `briefing.maxItemsPerTopic` | `8` | 每个主题最多入选条数 |
| `sources` | 见文件 | 来源默认开关，GUI 写入的 `settings/sources.json` 优先 |
| `im.kind` | `feishu` | `feishu` / `dingtalk` / `slack` / `telegram` / `generic` |
| `im.webhook` | 空 | 留空则只写本地文件、不推送 |

**webhook 建议用环境变量传**，不要提交进 git：

```bash
export IM_KIND=feishu
export IM_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
export IM_SECRET='...'            # 钉钉加签时用
export TELEGRAM_TOKEN='...'
export TELEGRAM_CHAT_ID='...'
```

## 去重与时间窗

三层：

1. **时间窗**：`publishedAt` 早于 `now - lookbackHours` 的丢弃。
2. **跨日去重**：
   - X：比对历史 `data/items-*.json` 里的 id 与**标题**。标题比全文稳定——正文常被追加浏览量，哈希会变。
   - 其他来源：比对最近 3 份 `briefings/*.md` 里出现过的 URL。
3. **已读状态**：`state/seen.json`，只用于增量模式。

**X 的特殊处理**：时间线没有结构化时间戳，所以会从正文里解析 `Oct 23` 这类日期写入 `publishedAt`，让它能受时间窗约束。

## 定时执行

当前配置：**每天 09:30（Asia/Shanghai）**，由 Harness 的会话定时任务触发，跑完后按 PLAYBOOK 产出并推送。

完全无人值守的替代方案（不依赖 Web 进程）：

```bash
dsh --profile headless "按 ~/personal/git/dsh-tech-radar/PLAYBOOK.md 执行今天的科技日报"
```

配合 launchd / cron 每天执行即可，但需要先创建一个 headless profile。

## 已知限制

- **X 强依赖代理。** 代理关闭时 X 采集器会熔断（连续两个网络失败就跳过剩余账号），日志里会写 `X 连续网络失败`。
- **Instagram / 微博 / Facebook / 抖音 拿不到。** 有登录墙或需签名，界面上标为不可用、不能勾选。
- **Bilibili 排行被风控。** 返回 `-352`，需要 Cookie，当前标为不可用。
- **GitHub Trending 榜单会被垃圾项目污染。** 盗版、DRM 绕过类仓库经常上榜，脚本层拦不住，需要编辑时人工筛。
- **体育类源偏薄。** BBC / Guardian / ESPN / CBS 的 RSS 在当前网络下返回 403 或超时，只剩 Yahoo Sports 与 Motorsport。
- **插件界面文案是硬编码中文**，没走 Client locale 服务。
- **插件改动需要重启 Harness 才生效**，Node 模块缓存不会自动重载。

## 成本与合规

- **成本**：全部免费。`r.jina.ai` 免费额度约 20 请求/分钟，一次完整采集约 20 个账号、每天一次，远低于限额。
- **合规**：只读公开内容，不登录、不伪造身份、不绕过访问控制。请求间有间隔。简报标注来源。个人研究用途无碍；对外分发请自行核对各平台条款。

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| X 采集 0 条 | 代理未开，`r.jina.ai` 不可达 | 开代理，别反复重试 |
| GitHub 报 `trending 页不可达` | 网页被挡 | 脚本已自动降级 Search API，正常 |
| 简报条数骤降 | 时间窗内确实没内容，或去重命中过多 | 先看 `stats` 里的 `fetched / onTopic / fresh` |
| 插件页面 401 | 浏览器凭据校验未通过 | 刷新页面；仍失败看 Origin |
| 插件页面 404 | 新路由未被加载 | 重启 Harness |
| 推送 `code != 0` | webhook 或签名问题 | 先 `--dry-run` 看 payload |
