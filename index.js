/**
 * Host 半边：给 Web 设置页提供两个面板的读写接口。
 *   - 主题：读 topics 目录、切换启用主题 → state/topics.json
 *   - 来源：切换启用的数据源 → state/sources.json
 *
 * 采集脚本启动时优先读这两个文件，所以 GUI 里点一下，下次 `node collect.mjs` 就生效。
 *
 * @module @local/dsh-tech-radar
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录：配置与主题都相对它定位，搬家不用改任何绝对路径。 */
const PKG_ROOT = dirname(fileURLToPath(import.meta.url));

export const name = 'tech-radar'
export const inject = ['connection', 'webServer']

/**
 * 来源注册表。status 决定界面上能不能勾：
 *   ok      可直接采集
 *   proxy   需要代理才能通
 *   blocked 平台侧不可达，只展示原因
 */
const SOURCES = [
  { id: 'x', name: 'X / Twitter', status: 'proxy', note: '经 r.jina.ai 渲染时间线，需要代理' },
  { id: 'rss', name: 'RSS / Atom', status: 'ok', note: '任意站点的订阅源，最稳的一类' },
  { id: 'hn', name: 'Hacker News', status: 'ok', note: 'Algolia API' },
  { id: 'github', name: 'GitHub Trending', status: 'ok', note: '网页抓取，失败自动降级到 Search API' },
  { id: 'arxiv', name: 'arXiv', status: 'ok', note: '官方 Atom API' },
  { id: 'telegram', name: 'Telegram 频道', status: 'ok', note: 't.me/s 公开预览页' },
  { id: 'bilibili', name: 'Bilibili 排行', status: 'blocked', note: '风控返回 -352，公开排行榜需 Cookie' },
  { id: 'weibo', name: '微博', status: 'blocked', note: '热搜接口需登录态，实测 403' },
  { id: 'instagram', name: 'Instagram', status: 'blocked', note: '未登录一律 302 到登录页，无帖子数据' },
  { id: 'facebook', name: 'Facebook', status: 'blocked', note: '需登录，无公开读取接口' },
  { id: 'douyin', name: '抖音', status: 'blocked', note: '无公开 API，需签名与登录态' },
]

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{topicsDir?: string, stateFile?: string, sourcesFile?: string}} [config]
 */
export function apply(ctx, config = {}) {
  // 缺省全部相对插件包定位；config 里仍可覆盖（比如把设置放到别处）
  const topicsDir = config.topicsDir ?? join(PKG_ROOT, 'topics')
  const stateFile = config.stateFile ?? join(PKG_ROOT, 'settings', 'topics.json')
  const sourcesFile = config.sourcesFile ?? join(PKG_ROOT, 'settings', 'sources.json')

  const log = (...args) => console.log('[tech-radar]', ...args)

  async function listTopics() {
    const files = (await readdir(topicsDir)).filter((file) => file.endsWith('.json'))
    const topics = []
    for (const file of files) {
      try {
        const pack = JSON.parse(await readFile(join(topicsDir, file), 'utf8'))
        if (!pack.id) continue
        topics.push({
          id: pack.id,
          name: pack.name ?? pack.id,
          emoji: pack.emoji ?? '',
          description: pack.description ?? '',
        })
      } catch (error) {
        log(`跳过坏主题文件 ${file}: ${error.message}`)
      }
    }
    topics.sort((a, b) => a.id.localeCompare(b.id))
    return topics
  }

  async function readJson(file, fallback) {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch {
      return fallback
    }
  }

  async function writeJson(file, value) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
  }

  const sendJson = (res, status, value) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(value))
  }

  /**
   * 复用平台自己的信任校验：Host/Origin 检查 + 浏览器凭据。
   * 这样本插件的路由与 /api 走同一套准入规则，而不是裸奔。
   * @returns {boolean} true 表示已拒绝并写回响应
   */
  const guard = (req, res) => {
    const rejection = ctx.connection.requestRejection({ headers: req.headers })
    if (!rejection) return false
    sendJson(res, rejection, { error: 'unauthorized' })
    return true
  }

  const readBody = async (req) => {
    let body = ''
    for await (const chunk of req) body += chunk
    return body ? JSON.parse(body) : {}
  }

  /* ------------------------------------------------------------ 主题 */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/tech-radar/state',
    async handler(req, res) {
      if (guard(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const topics = await listTopics()
        const state = await readJson(stateFile, { active: [] })
        const known = new Set(topics.map((topic) => topic.id))
        sendJson(res, 200, {
          topics,
          // 只回传仍然存在的主题，避免删掉主题包后残留幽灵条目
          active: (state.active ?? []).filter((id) => known.has(id)),
          updatedAt: state.updatedAt ?? null,
        })
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
    },
  }), 'tech-radar: GET /tech-radar/state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/tech-radar/activate',
    async handler(req, res) {
      if (guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        const known = new Set((await listTopics()).map((topic) => topic.id))
        const active = Array.isArray(body.active)
          ? [...new Set(body.active.filter((id) => typeof id === 'string' && known.has(id)))]
          : []
        if (active.length === 0) return sendJson(res, 400, { error: '至少需要启用一个主题' })
        const saved = { active, updatedAt: new Date().toISOString() }
        await writeJson(stateFile, saved)
        log(`启用主题：${active.join(', ')}`)
        sendJson(res, 200, saved)
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
    },
  }), 'tech-radar: POST /tech-radar/activate')

  /* ------------------------------------------------------------ 来源 */

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/tech-radar/sources',
    async handler(req, res) {
      if (guard(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const state = await readJson(sourcesFile, { enabled: {} })
        const overrides = state.enabled ?? {}
        sendJson(res, 200, {
          sources: SOURCES.map((source) => ({
            ...source,
            enabled: typeof overrides[source.id] === 'boolean'
              ? overrides[source.id]
              : source.status !== 'blocked',
          })),
          updatedAt: state.updatedAt ?? null,
        })
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
    },
  }), 'tech-radar: GET /tech-radar/sources')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/tech-radar/sources/toggle',
    async handler(req, res) {
      if (guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        const id = typeof body.id === 'string' ? body.id : ''
        const known = SOURCES.find((source) => source.id === id)
        if (!known) return sendJson(res, 400, { error: `未知来源：${id}` })
        if (known.status === 'blocked') {
          return sendJson(res, 400, { error: `${known.name} 当前不可用：${known.note}` })
        }
        const next = Boolean(body.enabled)
        const state = await readJson(sourcesFile, { enabled: {} })
        const saved = {
          enabled: { ...(state.enabled ?? {}), [id]: next },
          updatedAt: new Date().toISOString(),
        }
        await writeJson(sourcesFile, saved)
        log(`来源 ${id} → ${next ? '开' : '关'}`)
        sendJson(res, 200, saved)
      } catch (error) {
        sendJson(res, 500, { error: error.message })
      }
    },
  }), 'tech-radar: POST /tech-radar/sources/toggle')
}
