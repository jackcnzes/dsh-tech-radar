window.__ModuleLoader__.load({
  id: '@local/dsh-tech-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const palette = {
      border: 'rgba(127,127,127,0.28)',
      accent: 'rgba(64,132,255,0.85)',
      accentSoft: 'rgba(64,132,255,0.12)',
    }

    const button = (extra) => ({
      padding: '4px 10px',
      fontSize: 12,
      borderRadius: 8,
      border: `1px solid ${palette.border}`,
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      ...extra,
    })

    const note = (text) => h('div', { style: { fontSize: 13, opacity: 0.75, padding: '8px 0' } }, text)

    /* ------------------------------------------------------------ 热点主题 */

    function ActiveTopicRow({ topic, removable, disabled, onRemove }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: `1px solid ${palette.border}`,
            borderRadius: 10,
          },
        },
        h('span', { style: { fontSize: 18, lineHeight: 1 } }, topic.emoji || '•'),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
          h('span', { style: { fontWeight: 600 } }, topic.name),
          topic.description
            ? h('span', { style: { fontSize: 12, opacity: 0.7 } }, topic.description)
            : null,
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => onRemove(topic.id),
            disabled: disabled || !removable,
            title: removable ? '从待扫描中移除' : '至少保留一个主题',
            style: button({
              opacity: disabled || !removable ? 0.4 : 1,
              cursor: removable && !disabled ? 'pointer' : 'not-allowed',
            }),
          },
          '移除',
        ),
      )
    }

    function TopicsSection() {
      const [status, setStatus] = React.useState('loading')
      const [topics, setTopics] = React.useState([])
      const [active, setActive] = React.useState([])
      const [picking, setPicking] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/tech-radar/state', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setTopics(data.topics ?? [])
          setActive(data.active ?? [])
          setStatus('ready')
        } catch (error) {
          setStatus('error')
          setNotice(`读取失败：${error.message}`)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const save = async (next) => {
        const previous = active
        setActive(next)
        setSaving(true)
        setNotice('')
        try {
          const response = await fetch('/tech-radar/activate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ active: next }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          setActive(data.active ?? next)
          setNotice('已保存，下次采集生效')
        } catch (error) {
          setActive(previous)
          setNotice(`保存失败：${error.message}`)
        } finally {
          setSaving(false)
        }
      }

      const add = () => {
        if (!picking || active.includes(picking)) return
        save([...active, picking])
        setPicking('')
      }

      const remove = (id) => {
        if (active.length <= 1) {
          setNotice('至少保留一个主题')
          return
        }
        save(active.filter((item) => item !== id))
      }

      if (status === 'loading') return note('正在读取主题…')
      if (status === 'error') return note(notice)

      const byId = new Map(topics.map((topic) => [topic.id, topic]))
      const activeTopics = active.map((id) => byId.get(id)).filter(Boolean)
      const available = topics.filter((topic) => !active.includes(topic.id))

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('div', { style: { fontSize: 12, opacity: 0.65 } }, `待扫描（${activeTopics.length}）`),
          activeTopics.length === 0
            ? note('还没有选择主题，从下面添加一个。')
            : activeTopics.map((topic) => h(ActiveTopicRow, {
              key: topic.id,
              topic,
              removable: activeTopics.length > 1,
              disabled: saving,
              onRemove: remove,
            })),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              paddingTop: 12,
              borderTop: `1px dashed ${palette.border}`,
            },
          },
          h(
            'select',
            {
              value: picking,
              disabled: saving || available.length === 0,
              onChange: (event) => setPicking(event.target.value),
              style: {
                flex: 1,
                minWidth: 0,
                padding: '7px 10px',
                fontSize: 13,
                borderRadius: 8,
                border: `1px solid ${palette.border}`,
                background: 'transparent',
                color: 'inherit',
              },
            },
            h('option', { value: '' }, available.length === 0 ? '没有可添加的主题了' : '选择要添加的主题…'),
            available.map((topic) => h(
              'option',
              { key: topic.id, value: topic.id },
              `${topic.emoji ? `${topic.emoji} ` : ''}${topic.name}　${topic.description || ''}`,
            )),
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: add,
              disabled: saving || !picking,
              style: button({
                padding: '7px 14px',
                fontSize: 13,
                borderColor: palette.accent,
                opacity: picking && !saving ? 1 : 0.45,
                cursor: picking && !saving ? 'pointer' : 'not-allowed',
              }),
            },
            '添加',
          ),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 12,
              opacity: notice ? 0.9 : 0.6,
            },
          },
          h('span', null, notice || `共 ${topics.length} 个可用主题`),
          h('button', { type: 'button', onClick: load, disabled: saving, style: button({ opacity: saving ? 0.5 : 1 }) }, '刷新'),
        ),
      )
    }

    /* ------------------------------------------------------------ 热点来源 */

    const STATUS_STYLE = {
      ok: { label: '可用', color: 'rgba(34,160,90,0.95)' },
      proxy: { label: '需代理', color: 'rgba(214,140,30,0.95)' },
      blocked: { label: '不可用', color: 'rgba(150,150,150,0.95)' },
    }

    function SourcesSection() {
      const [status, setStatus] = React.useState('loading')
      const [sources, setSources] = React.useState([])
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/tech-radar/sources', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const data = await response.json()
          setSources(data.sources ?? [])
          setStatus('ready')
        } catch (error) {
          setStatus('error')
          setNotice(`读取失败：${error.message}`)
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const toggle = async (source) => {
        if (source.status === 'blocked') {
          setNotice(`${source.name} 不可用：${source.note}`)
          return
        }
        const next = !source.enabled
        setBusy(source.id)
        setNotice('')
        setSources((prev) => prev.map((item) => (item.id === source.id ? { ...item, enabled: next } : item)))
        try {
          const response = await fetch('/tech-radar/sources/toggle', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: source.id, enabled: next }),
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
          setNotice(`${source.name} 已${next ? '启用' : '停用'}，下次采集生效`)
        } catch (error) {
          setSources((prev) => prev.map((item) => (item.id === source.id ? { ...item, enabled: !next } : item)))
          setNotice(`保存失败：${error.message}`)
        } finally {
          setBusy('')
        }
      }

      if (status === 'loading') return note('正在读取数据源…')
      if (status === 'error') return note(notice)

      const enabledCount = sources.filter((item) => item.enabled && item.status !== 'blocked').length

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } },
          '哪些渠道参与采集。标"不可用"的平台是实测拿不到内容（登录墙或无公开接口），只展示原因，不能勾选。',
        ),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          sources.map((source) => {
            const meta = STATUS_STYLE[source.status] ?? STATUS_STYLE.ok
            const blocked = source.status === 'blocked'
            return h(
              'div',
              {
                key: source.id,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  border: `1px solid ${palette.border}`,
                  borderRadius: 10,
                  opacity: blocked ? 0.55 : 1,
                },
              },
              h(
                'span',
                { style: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 } },
                h(
                  'span',
                  { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 } },
                  source.name,
                  h(
                    'span',
                    {
                      style: {
                        fontSize: 11,
                        fontWeight: 500,
                        color: meta.color,
                        border: `1px solid ${meta.color}`,
                        borderRadius: 999,
                        padding: '1px 7px',
                      },
                    },
                    meta.label,
                  ),
                ),
                h('span', { style: { fontSize: 12, opacity: 0.7 } }, source.note),
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: blocked || busy === source.id,
                  onClick: () => toggle(source),
                  style: button({
                    minWidth: 56,
                    padding: '6px 12px',
                    fontSize: 12,
                    borderColor: source.enabled && !blocked ? palette.accent : palette.border,
                    opacity: blocked ? 0.5 : busy === source.id ? 0.6 : 1,
                    cursor: blocked || busy === source.id ? 'not-allowed' : 'pointer',
                  }),
                },
                blocked ? '—' : source.enabled ? '已启用' : '已停用',
              ),
            )
          }),
        ),
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              fontSize: 12,
              opacity: notice ? 0.9 : 0.6,
            },
          },
          h('span', null, notice || `共 ${sources.length} 个来源，${enabledCount} 个启用中`),
          h('button', { type: 'button', onClick: load, style: button({}) }, '刷新'),
        ),
      )
    }

    /* -------------------------------------------------------------- 外壳 */

    const MENU = [
      { id: 'topics', label: '热点主题', hint: '扫哪些领域' },
      { id: 'sources', label: '热点来源', hint: '从哪些渠道扫' },
    ]

    function RadarPanel() {
      const [view, setView] = React.useState('topics')

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 16, padding: 16, maxWidth: 640 } },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '热点雷达'),
          h(
            'div',
            { style: { fontSize: 12, opacity: 0.7, lineHeight: 1.5 } },
            '先选扫什么领域，再选从哪些渠道扫。两处改完都对下一次采集生效。',
          ),
        ),
        h(
          'div',
          {
            role: 'tablist',
            style: {
              display: 'flex',
              gap: 6,
              padding: 4,
              border: `1px solid ${palette.border}`,
              borderRadius: 10,
            },
          },
          MENU.map((item) => {
            const selected = view === item.id
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'tab',
                'aria-selected': selected,
                onClick: () => setView(item.id),
                style: {
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                  alignItems: 'flex-start',
                  padding: '7px 12px',
                  fontSize: 13,
                  fontWeight: selected ? 600 : 400,
                  borderRadius: 8,
                  border: `1px solid ${selected ? palette.accent : 'transparent'}`,
                  background: selected ? palette.accentSoft : 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                },
              },
              h('span', null, item.label),
              h('span', { style: { fontSize: 11, opacity: 0.6 } }, item.hint),
            )
          }),
        ),
        view === 'topics' ? h(TopicsSection) : h(SourcesSection),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register(
          {
            name: 'settings.plugins.tab',
            id: 'tech-radar',
            order: 40,
            label: '热点雷达',
          },
          RadarPanel,
        ))
      },
    }
  },
})
