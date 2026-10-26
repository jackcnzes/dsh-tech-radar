# Tech Radar · tech-radar

[中文](README.md) ｜ English

## What this is

It collects public signals from X, RSS, Hacker News, GitHub, arXiv and Telegram, turns them into a daily Chinese-language briefing, and pushes it to your IM. Topics are pluggable (tech / sports / cars / finance / games / science), and you can follow individual tech voices to see what they have been talking about.

**What it is not**: not a full-site trending scraper, not social listening. It only reads public content — no login, no bypassing of access control.

## Features

- **Pluggable topics** — one JSON file per topic, switch anytime, run several at once and merge them into a multi-section briefing.
- **Influencer tracking** — aggregate one person's recent posts and summarise what they are focusing on.
- **Cross-day de-duplication** — matches both URLs and titles, so the same story does not run two days in a row.
- **Two modes** — incremental (only what is new since last run) and full window (used by the daily briefing).
- **Multiple destinations** — Feishu / DingTalk / Slack / Telegram / any webhook.
- **GUI configuration** — an installable Harness plugin with a settings page.

## Measured data sources

This project exists because of this section: feasibility depends entirely on whether data can actually be fetched. The table below is measured in Oct 2026, not assumed.

| Source | Status | Method | Result |
|---|---|---|---|
| RSS / Atom | ✅ | Direct feeds | Most reliable; covers most outlets and blogs |
| Hacker News | ✅ | Algolia API | Structured JSON, 30 items per call |
| GitHub Trending | ✅ | HTML scrape | Falls back to the Search API on failure |
| arXiv | ✅ | Official Atom API | Sorted by category and submission date |
| Telegram channels | ✅ | `t.me/s/<channel>` | Public preview page, 17 messages measured |
| X / Twitter | ⚠️ proxy | Rendered via `r.jina.ai` | Unreachable without a proxy; search always requires login |
| Bilibili ranking | ❌ | Ranking API | Risk control returns `-352`, needs cookies |
| Weibo | ❌ | Hot-search API | Requires login, 403 measured |
| Instagram | ❌ | Public profile | Always 302 to the login page, zero posts |
| Facebook | ❌ | Public page | Requires login, no public read API |
| Douyin | ❌ | — | No public API, needs signing and login |

Two traps worth knowing:

1. **X can only be fetched per account, never by topic.** The search page requires login, so "what is hot on X today" is unavailable. The substitute is a curated account list, cross-checked against objective HN / GitHub signals.
2. **Fetching must run in a subprocess.** With fake-IP DNS (`x.com → 198.18.0.57`), the Harness `web_fetch` tool rejects the address as non-public, while `curl` and Node `fetch` go through the system proxy fine. The collector is therefore standalone and does not rely on the agent's fetch tool.

## Architecture

```
X · RSS · HN · GitHub · arXiv · Telegram
              │  collect.mjs
              │  concurrent fetch → normalise → relevance → cross-day dedup
              ▼
   <outputDir>/data/items-YYYY-MM-DD.json
              │  Agent + PLAYBOOK.md
              │  select → cluster by topic → write facts and judgement
              ▼
   <outputDir>/briefings/YYYY-MM-DD.md
              │  push.mjs
              ▼
   Feishu / DingTalk / Slack / Telegram
```

**Design rule: determinism in scripts, judgement in the model.** Fetching, dedup, filtering and delivery are plain scripts — cheap, reproducible, debuggable. Only "which items, and what do they mean" goes to the LLM.

## Layout

```
dsh-tech-radar/            code and configuration (installable plugin package)
├── index.js               Host half: four HTTP routes
├── client.js              Client half: settings panel
├── collect.mjs            collector entry
├── push.mjs               delivery entry
├── voice.mjs              inspect an influencer's recent posts
├── lib/http.mjs           fetch with timeout/retry, content hashing
├── lib/parse.mjs          per-source parsers
├── topics/                topic packs (6)
├── settings/              toggles written by the GUI
├── config.json            global configuration
├── cordis.patch.yml       plugin registration (no absolute paths)
├── PLAYBOOK.md            daily runbook for the agent
└── tools/mock-im.mjs      local webhook receiver for testing

tech-radar/                runtime output (not part of the package)
├── data/                  collected items and voices
├── briefings/             daily briefings
└── state/seen.json        read records for incremental mode
```

Code and output are separated so that a growing pile of daily results never ends up inside an installable, publishable package. The output location is `config.json` → `outputDir`, default `../tech-radar`.

## Quick start

```bash
cd ~/personal/git/dsh-tech-radar
node collect.mjs --all
node voice.mjs --list
IM_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx' \
  node push.mjs --file ../tech-radar/briefings/$(date +%F).md
```

## Topic packs

Each topic is one file under `topics/`. Fields:

- `keywords` — relevance terms, applied only to sources listed in `filterSources` (default `hn`, `rss`, `bilibili`). X / GitHub / arXiv / Telegram are allow-listed and always pass.
- `x.handles` — organisation accounts that feed the hot list.
- `influencers` — individual accounts for the "what influencers are saying" section.
- `telegram` — channel names (the part after `t.me/s/`).
- `hackernews` / `github` / `arxiv` — set `enabled: false` to skip those sources for this topic.

Six packs ship by default: `tech`, `sports`, `auto`, `finance`, `games`, `science`. To add a topic, add a JSON file — no code change, and it appears in the GUI dropdown on reopen.

## Influencers

Defined per topic. Commands:

```bash
node voice.mjs --list
node voice.mjs --topic=tech --list
node voice.mjs karpathy
node voice.mjs --all
```

Deliberate trade-off: **influencer data is excluded from the "is it new" filter.** The question is "what has this person been saying", not "what happened today" — a timeline that has not changed for a week is still informative about their position. `voice.mjs` only fetches and formats; meaning is the agent's job.

## Harness plugin

`dsh-tech-radar/` is also an installable Cordis plugin. After installation, **Settings → Plugins → Tech Radar** is one page with two sub-menus: **Topics** (add/remove via dropdown) and **Sources** (11 sources with status and toggles).

All four routes pass through `ctx.connection.requestRejection()` first, so they share the platform's Host/Origin and browser-credential checks rather than being open:

| Method | Path | Purpose |
|---|---|---|
| GET | `/tech-radar/state` | Topic list and current selection |
| POST | `/tech-radar/activate` | Write `settings/topics.json` |
| GET | `/tech-radar/sources` | Source list and toggles |
| POST | `/tech-radar/sources/toggle` | Write `settings/sources.json` |

Paths are derived from `import.meta.url`; `cordis.patch.yml` contains no absolute paths, so the whole directory can move without editing configuration. Only moving or renaming the package directory itself requires re-running `install_bundle`.

## Command-line reference

| Command | Purpose |
|---|---|
| `node collect.mjs` | Incremental: only what is new since the last run |
| `node collect.mjs --all` | Full window by `lookbackHours` — **use this for the daily briefing** |
| `node collect.mjs --topics=tech,auto` | Override topics for this run (beats GUI and config) |
| `node collect.mjs --source=rss,hn` | Run only the named sources |
| `node collect.mjs --dry` | Collect without updating read records |
| `node push.mjs --file <path>` | Push the given briefing |
| `node push.mjs --dry-run` | Print the payload only |
| `node voice.mjs [handle]` | Show one influencer's recent posts |
| `node tools/mock-im.mjs 8899` | Start a local webhook receiver |

## Configuration

`config.json`:

| Field | Default | Meaning |
|---|---|---|
| `outputDir` | `../tech-radar` | Output directory, relative to the package |
| `activeTopics` | `["tech"]` | Fallback topics when the GUI has written nothing |
| `briefing.lookbackHours` | `24` | Time window |
| `briefing.maxItemsPerTopic` | `8` | Maximum picks per topic |
| `sources` | see file | Default source switches; `settings/sources.json` wins |
| `im.kind` | `feishu` | `feishu` / `dingtalk` / `slack` / `telegram` / `generic` |
| `im.webhook` | empty | When empty, nothing is pushed and only local files are written |

**Pass the webhook through environment variables**, never commit it:

```bash
export IM_KIND=feishu
export IM_WEBHOOK='https://open.feishu.cn/open-apis/bot/v2/hook/xxx'
export IM_SECRET='...'            # DingTalk signed robots
export TELEGRAM_TOKEN='...'
export TELEGRAM_CHAT_ID='...'
```

## De-duplication and time window

Three layers:

1. **Time window** — drop items whose `publishedAt` is older than `now - lookbackHours`.
2. **Cross-day dedup** — for X, compare ids and **titles** against historical `data/items-*.json` (titles are more stable than full text, which accumulates view counts); for everything else, compare URLs against the last three briefings.
3. **Read records** — `state/seen.json`, used only in incremental mode.

X needs special handling: its timeline has no structured timestamps, so dates such as `Oct 23` are parsed out of the post body into `publishedAt`.

## Scheduling

Current setup: daily at **09:30 Asia/Shanghai**, triggered by a Harness session reminder; the agent then follows `PLAYBOOK.md` to produce and push the briefing.

Fully unattended alternative:

```bash
dsh --profile headless "follow ~/personal/git/dsh-tech-radar/PLAYBOOK.md and run today's briefing"
```

Pair it with launchd or cron; creating a headless profile is a one-time prerequisite.

## Known limitations

- **X depends on a proxy.** Without it the collector trips its breaker after two consecutive network failures and logs `X 连续网络失败`.
- **Instagram / Weibo / Facebook / Douyin are unreachable** — login walls or request signing. Marked unavailable in the UI, not selectable.
- **Bilibili ranking is behind risk control** (`-352`, needs cookies); currently marked unavailable.
- **GitHub Trending is polluted** by piracy and DRM-circumvention repos. Not blocked at script level; filtered by the editor.
- **Sports sources are thin** — BBC, Guardian, ESPN and CBS feeds return 403 or time out on this network; only Yahoo Sports and Motorsport work.
- **Plugin UI text is hardcoded Chinese**; it does not go through the Client locale service.
- **Plugin changes require a Harness restart** — Node's module cache does not hot-reload.

## Cost and compliance

Everything is free. `r.jina.ai` allows roughly 20 requests per minute on the free tier; one daily run touches about 20 accounts, well below that. The collector only reads public content, never logs in, never bypasses access control, and spaces out requests. Fine for personal research; check each platform's terms before redistributing.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| X returns 0 items | Proxy off, `r.jina.ai` unreachable | Enable the proxy; do not retry in a loop |
| GitHub logs `trending 页不可达` | Page blocked | Expected; the Search API fallback handles it |
| Briefing suddenly small | Genuinely quiet window, or heavy dedup | Inspect `fetched / onTopic / fresh` in `stats` |
| Plugin page returns 401 | Browser credential check failed | Reload; inspect Origin if it persists |
| Plugin page returns 404 | New routes not loaded | Restart Harness |
| Push returns `code != 0` | Webhook or signature problem | Run with `--dry-run` first |
