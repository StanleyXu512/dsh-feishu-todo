'use strict'

/**
 * dsh-feishu-todo — 浏览器半边（跑在 dsh web GUI 内）。
 *
 * 挂载：
 * - 右下角浮动入口按钮（toggle 面板）
 * - 浮动面板（状态 / 待办 / 群聊 三页签）
 * 数据唯一入口是同源的 /api/feishu-todo/* 路由（普通 fetch），与宿主半边通信。
 * 配置、个人授权在「设置 → 插件 → 可配置」的「飞书待办」卡片里完成：宿主半边
 * installSettingsSection 注册命名空间与 schema，本半边经 settings.plugin.item
 * （keyed，key 即命名空间）注册卡片并回写。
 *
 * 失败策略：DOM 挂载错误只 console.warn，绝不 throw —— 外部插件抛异常会拖垮
 * 整个 web 引导，不能让它把 GUI 带崩。
 */

window.__ModuleLoader__.load({
  id: 'dsh-feishu-todo',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createRoot } = require('react-dom/client')

    const el = React.createElement

    // ------------------------------------------------------------------ CSS
    const CSS = `
.ft-fab-wrap { position:fixed; right:18px; bottom:18px; z-index:9990; pointer-events:auto; cursor:grab; touch-action:none; user-select:none; -webkit-user-select:none; }
/* 消息栏提示条：定时识别新增待办时在页面顶部右侧浮出，可拖动，点击取消 */
.ft-toast { position:fixed; top:72px; right:20px; z-index:9993; display:flex; align-items:center; gap:10px; max-width:min(420px, calc(100vw - 40px)); padding:10px 12px 10px 14px; background:#eef4fb; color:#0a66c2; border:1px solid rgba(10,102,194,.35); border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.18); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; cursor:grab; touch-action:none; user-select:none; -webkit-user-select:none; pointer-events:auto; animation:ft-toast-in .18s ease-out; }
@keyframes ft-toast-in { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
.ft-toast:hover { background:#e3ecf7; }
.ft-toast-text { flex:1; min-width:0; word-break:break-all; }
.ft-toast-close { border:none; background:transparent; color:#0a66c2; font-size:14px; cursor:pointer; padding:0 2px; flex-shrink:0; line-height:1; }
.ft-fab { position:static; display:block; width:44px; height:44px; border-radius:22px; border:none; cursor:pointer; background:#0a66c2; color:#fff; font-size:20px; line-height:44px; text-align:center; box-shadow:0 4px 16px rgba(0,0,0,.25); pointer-events:auto; }
.ft-fab:hover { background:#0b5caf; }
.ft-fab-badge { position:absolute; top:-4px; right:-4px; min-width:18px; height:18px; border-radius:9px; background:#d93025; color:#fff; font-size:11px; font-weight:600; line-height:14px; text-align:center; padding:0 4px; box-sizing:border-box; border:2px solid #fff; pointer-events:none; }
.ft-notify { display:flex; align-items:center; gap:8px; padding:8px 14px; background:#fff8e6; border-bottom:1px solid rgba(0,0,0,.08); font-size:12px; color:#7a5b00; }
.ft-notify-text { flex:1; min-width:0; word-break:break-all; }
.ft-notify-btn { border:none; background:#0a66c2; color:#fff; border-radius:6px; padding:3px 10px; font-size:12px; cursor:pointer; flex-shrink:0; }
.ft-notify-btn:hover { background:#0b5caf; }
.ft-overlay { position:fixed; z-index:9995; top:64px; right:20px; width:440px; max-width:calc(100vw - 40px); max-height:calc(100vh - 84px); display:flex; flex-direction:column; background:#fff; color:#1f2328; border:1px solid rgba(0,0,0,.12); border-radius:12px; box-shadow:0 8px 40px rgba(0,0,0,.2); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:13px; overflow:hidden; pointer-events:auto; }
.ft-head { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid rgba(0,0,0,.08); }
.ft-title { font-weight:600; font-size:14px; }
.ft-close { border:none; background:transparent; cursor:pointer; font-size:20px; line-height:1; color:#777; padding:0 2px; }
.ft-tabs { display:flex; gap:2px; padding:8px 12px 0; border-bottom:1px solid rgba(0,0,0,.08); }
.ft-tab { border:none; background:transparent; padding:7px 12px; cursor:pointer; font-size:13px; color:#555; border-bottom:2px solid transparent; }
.ft-tab-active { color:#0a66c2; border-bottom-color:#0a66c2; font-weight:600; }
.ft-body { padding:14px; overflow-y:auto; }
.ft-section { margin-bottom:16px; }
.ft-section-title { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#999; margin:12px 0 8px; font-weight:600; }
.ft-row { display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid rgba(0,0,0,.05); gap:10px; }
.ft-k { color:#666; flex-shrink:0; }
.ft-v { font-weight:500; text-align:right; word-break:break-all; }
.ft-badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px; font-weight:600; }
.ft-badge-green { background:#e6f4ea; color:#1a7f37; }
.ft-badge-red { background:#fdecea; color:#c0392b; }
.ft-badge-gray { background:#f0f0f0; color:#666; }
.ft-badge-blue { background:#eef4fb; color:#0a66c2; }
.ft-todo-unread { border-color:#0a66c2; background:#f6f9fd; cursor:pointer; }
.ft-todo-unread:hover { background:#eef3fb; }
.ft-todo-unread-badge { margin-right:6px; vertical-align:1px; }
.ft-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; border:1px solid rgba(0,0,0,.15); background:#fff; color:#222; padding:6px 12px; border-radius:7px; cursor:pointer; font-size:12px; }
.ft-btn:hover { background:#f6f8fa; }
.ft-btn:disabled { opacity:.5; cursor:not-allowed; }
.ft-btn-primary { background:#0a66c2; border-color:#0a66c2; color:#fff; }
.ft-btn-primary:hover { background:#0b5caf; }
.ft-btn-small { padding:3px 9px; font-size:11px; }
.ft-btn-danger { color:#c0392b; border-color:rgba(192,57,43,.35); }
.ft-actions { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
.ft-seg { display:flex; gap:8px; margin:10px 0 4px; }
.ft-seg-btn { flex:1; border:1px solid rgba(0,0,0,.12); background:#fff; color:#555; padding:5px 0; border-radius:7px; cursor:pointer; font-size:12px; }
.ft-seg-btn:hover { background:#f6f8fa; }
.ft-seg-active { background:#eef4fb; border-color:#0a66c2; color:#0a66c2; font-weight:600; }
.ft-select { border:1px solid rgba(0,0,0,.15); border-radius:7px; padding:5px 8px; font-size:12px; background:#fff; color:#222; }
.ft-tools { display:flex; gap:8px; align-items:center; margin:8px 0; }
.ft-tools .ft-select { flex-shrink:0; }
.ft-search-inline { flex:1; min-width:0; margin-bottom:0; }
.ft-todo { padding:9px 11px; border:1px solid rgba(0,0,0,.08); border-radius:8px; margin-bottom:8px; background:#fafbfc; }
.ft-todo-head { display:flex; gap:8px; align-items:flex-start; }
.ft-todo-main { flex:1; min-width:0; }
.ft-todo-head .ft-btn, .ft-todo-head .ft-todo-check { flex-shrink:0; }
.ft-todo-check { margin-top:2px; }
.ft-todo-title { font-weight:500; word-break:break-word; }
.ft-todo-done { text-decoration:line-through; color:#999; }
.ft-todo-meta { font-size:11px; color:#777; margin-top:3px; word-break:break-word; }
.ft-todo-link { color:#0a66c2; text-decoration:none; }
.ft-err { background:#fdecea; color:#c0392b; padding:8px 10px; border-radius:7px; margin:8px 0; font-size:12px; word-break:break-all; }
.ft-msg { background:#e6f4ea; color:#1a7f37; padding:8px 10px; border-radius:7px; margin:8px 0; font-size:12px; }
.ft-empty { color:#999; text-align:center; padding:24px 0; }
.ft-chat-row { padding:7px 8px; border:1px solid rgba(0,0,0,.06); border-radius:8px; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center; gap:10px; }
.ft-chat-row-followed { border-color:#0a66c2; background:#eef4fb; }
.ft-chat-info { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
.ft-chat-name { word-break:break-all; }
.ft-chat-count { color:#888; font-size:11px; }
.ft-search { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid rgba(0,0,0,.15); border-radius:8px; font-size:13px; margin-bottom:8px; background:transparent; color:var(--dsw-alias-label-primary,#1f2328); }
.ft-only-followed { display:flex; align-items:center; gap:6px; font-size:12px; color:#555; margin-bottom:8px; cursor:pointer; }
.ft-hint { font-size:12px; color:#888; margin-top:2px; }
/* 设置卡片（官方「插件 → 可配置」内渲染）——标题可折叠/展开 */
.ft-card { border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12)); background:var(--dsw-alias-bg-layer-3,transparent); border-radius:12px; list-style:none; transition:border-color .16s, background .16s; box-sizing:border-box; }
.ft-card:hover { border-color:var(--dsw-alias-label-dimmed,#888); }
.ft-card-open { background:var(--dsw-alias-bg-layer-2,transparent); border-color:var(--dsw-alias-label-dimmed,#888); }
.ft-card-header { appearance:none; width:100%; font:inherit; color:inherit; text-align:left; cursor:pointer; background:transparent; border:0; border-radius:12px; align-items:center; gap:12px; padding:14px 16px; display:flex; box-sizing:border-box; }
.ft-card-header:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#0a66c2); outline-offset:-2px; }
.ft-card-head-text { flex-direction:column; flex:1; gap:4px; min-width:0; display:flex; }
.ft-card-title { margin:0; color:var(--dsw-alias-label-primary,#1f2328); font-size:15px; font-weight:600; line-height:1.4; }
.ft-card-desc { margin:0; color:var(--dsw-alias-label-tertiary,#777); font-size:13px; line-height:1.5; }
.ft-card-pending { white-space:nowrap; background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.06)); color:var(--dsw-alias-label-secondary,#666); border-radius:999px; flex:none; padding:1px 8px; font-size:11px; font-weight:500; line-height:17px; }
.ft-card-chevron { color:var(--dsw-alias-label-tertiary,#999); flex:none; font-size:14px; line-height:1; transition:transform .16s; }
.ft-card-chevron-open { transform:rotate(180deg); }
.ft-card-body { border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08)); margin:0 16px; padding:14px 0 8px; display:flex; flex-direction:column; gap:12px; }
.ft-set-row { display:flex; flex-direction:column; gap:5px; }
.ft-set-row-bool { flex-direction:row; align-items:center; gap:10px; }
.ft-set-label { font-size:13px; font-weight:500; color:var(--dsw-alias-label-primary,#1f2328); }
.ft-set-input { width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15)); border-radius:8px; font-size:13px; background:transparent; color:var(--dsw-alias-label-primary,#1f2328); }
.ft-set-input:disabled { opacity:.5; }
.ft-set-check { margin:0; width:16px; height:16px; }
.ft-set-hint { margin:0; font-size:11px; color:var(--dsw-alias-label-tertiary,#999); }
.ft-card-actions { display:flex; justify-content:flex-end; gap:8px; border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08)); padding-top:12px; margin-top:2px; }
`

    // ------------------------------------------------------------------ 助手
    function Btn(props) {
      return el('button', {
        className: 'ft-btn' + (props.primary ? ' ft-btn-primary' : '') + (props.small ? ' ft-btn-small' : '') + (props.danger ? ' ft-btn-danger' : ''),
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title || '',
      }, props.label)
    }

    function Badge(props) {
      return el('span', { className: 'ft-badge ft-badge-' + (props.tone || 'gray') }, props.label)
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    function fmtMs(ms) {
      if (!ms) return ''
      const h = Math.floor(ms / 3600000)
      const m = Math.floor((ms % 3600000) / 60000)
      if (h > 0) return h + ' 小时 ' + m + ' 分钟'
      if (m > 0) return m + ' 分钟'
      return '即将过期'
    }

    // 已完成归档的时间筛选
    const ARCHIVE_RANGES = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部']]
    function archiveCutoff(range) {
      const now = Date.now()
      if (range === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() }
      if (range === '7d') return now - 7 * 86400000
      if (range === '30d') return now - 30 * 86400000
      return 0
    }

    // ------------------------------------------------------------------ API
    const API = {
      state: '/api/feishu-todo/state',
      sync: '/api/feishu-todo/sync',
      todos: '/api/feishu-todo/todos',
      follow: '/api/feishu-todo/follow',
      todoDone: '/api/feishu-todo/todo-done',
      todoSeen: '/api/feishu-todo/todo-seen',
      todoSeenAll: '/api/feishu-todo/todo-seen-all',
      todoRestore: '/api/feishu-todo/todo-restore',
      notifyAck: '/api/feishu-todo/notify-ack',
      chatsSearch: '/api/feishu-todo/chats/search',
      authStart: '/api/feishu-todo/auth/start',
      authStatus: '/api/feishu-todo/auth/status',
      authCancel: '/api/feishu-todo/auth/cancel',
      authRefresh: '/api/feishu-todo/auth/refresh',
      authRevoke: '/api/feishu-todo/auth/revoke',
    }

    async function api(path, { method = 'GET', body, timeoutMs = 900000 } = {}) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res
      try {
        res = await fetch(path, {
          method,
          headers: body ? { 'content-type': 'application/json' } : undefined,
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        })
      } catch (e) {
        clearTimeout(timer)
        throw new Error(/abort|timeout/i.test(String(e && e.message)) ? '请求超时' : '网络错误: ' + (e && e.message))
      }
      clearTimeout(timer)
      let json = null
      try { json = await res.json() } catch (e) {}
      if (!res.ok) {
        throw new Error((json && json.error) || ('HTTP ' + res.status))
      }
      return json
    }

    function useAuthPoll(authUrl, onSuccess, onFail) {
      React.useEffect(function () {
        if (!authUrl) return
        let stopped = false
        ;(async function poll() {
          while (!stopped) {
            await new Promise(function (r) { setTimeout(r, 1500) })
            if (stopped) return
            let s
            try { s = await api(API.authStatus) } catch (e) { s = null }
            if (!s) continue
            if (s.hasUserToken) { onSuccess(); return }
            if (!s.running) { onFail(s.error); return }
          }
        })()
        return function () { stopped = true }
      }, [authUrl])
    }

    // ------------------------------------------------------------------ Panel
    function Panel(props) {
      const [state, setState] = React.useState(null)
      const [tab, setTab] = React.useState(props.initialTab || 'status')
      const [busy, setBusy] = React.useState('')
      const [err, setErr] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [todos, setTodos] = React.useState([])
      const [chatQuery, setChatQuery] = React.useState('')
      const [onlyFollowed, setOnlyFollowed] = React.useState(false)
      const [searchResults, setSearchResults] = React.useState(null)
      const [authUrl, setAuthUrl] = React.useState('')
      const [completedView, setCompletedView] = React.useState(false) // 待办页：false=待办列表，true=已完成归档
      const [archiveRange, setArchiveRange] = React.useState('7d') // 归档时间筛选：today/7d/30d/all
      const [todoQuery, setTodoQuery] = React.useState('') // 待办列表文本搜索
      const [archiveQuery, setArchiveQuery] = React.useState('') // 已完成归档文本搜索

      async function refresh() {
        try {
          const r = await api(API.state)
          setState(r.state)
          if (r.state && Array.isArray(r.state.data.todos)) setTodos(r.state.data.todos)
          return r.state
        } catch (e) {
          setErr((e && e.message) || String(e))
          return null
        }
      }

      React.useEffect(function () { refresh() }, [])

      // 群搜索：输入即走飞书服务端搜索（覆盖全部群，不受缓存上限影响），300ms 防抖
      React.useEffect(function () {
        const q = chatQuery.trim()
        if (!q) { setSearchResults(null); return }
        let stopped = false
        const timer = setTimeout(async function () {
          try {
            const r = await api(API.chatsSearch, { method: 'POST', body: { query: q } })
            if (!stopped) setSearchResults(r.chats || [])
          } catch (e) {
            if (!stopped) { setErr((e && e.message) || String(e)); setSearchResults([]) }
          }
        }, 300)
        return function () { stopped = true; clearTimeout(timer) }
      }, [chatQuery])

      useAuthPoll(authUrl, function () {
        setAuthUrl('')
        setMsg('授权成功！')
        setErr('')
        refresh()
      }, function (authErr) {
        setAuthUrl('')
        setErr('授权未完成。' + (authErr ? '（' + authErr + '）' : '') + ' 请重试。')
        refresh()
      })

      function run(fn) {
        return async function () {
          setErr('')
          setMsg('')
          setBusy('working')
          try { await fn.apply(null, arguments) } catch (e) { setErr((e && e.message) || String(e)) } finally { setBusy('') }
        }
      }

      const doSync = run(async function () {
        const r = await api(API.sync, { method: 'POST', body: {} })
        setState(r.state)
        const sm = r.summary
        setMsg(sm
          ? ('同步完成：' + (sm.incremental ? '增量 +' + (sm.newMessages || 0) + ' 条 · 共 ' : '共 ') + (sm.messages || 0) + ' 条消息 · 关注 ' + (sm.followed || 0) + ' 群')
          : '同步完成')
      })

      const doTodos = run(async function (refreshFirst) {
        const r = await api(API.todos, { method: 'POST', body: { refresh: Boolean(refreshFirst) } })
        setState(r.state)
        const list = r.state && r.state.data && r.state.data.todos || []
        setTodos(list)
        setMsg('已识别 ' + list.length + ' 条待办')
      })

      const doAuth = run(async function () {
        const r = await api(API.authStart, { method: 'POST', body: {} })
        if (r.authorizeUrl) {
          setAuthUrl(r.authorizeUrl)
          window.open(r.authorizeUrl, '_blank', 'noopener')
        } else {
          setErr('未获取到授权链接。')
        }
      })

      const doRefreshToken = run(async function () {
        await api(API.authRefresh, { method: 'POST', body: {} })
        setMsg('token 已刷新')
        refresh()
      })

      const doRevoke = run(async function () {
        await api(API.authRevoke, { method: 'POST', body: {} })
        setMsg('已清除个人授权')
        refresh()
      })

      const doCancelAuth = run(async function () {
        await api(API.authCancel, { method: 'POST', body: {} })
        setAuthUrl('')
      })

      const doFollow = run(async function (chatId, followed) {
        const r = await api(API.follow, { method: 'POST', body: { chatId: chatId, followed: followed } })
        setState(r.state)
        // 同步更新搜索结果里的关注态（若有）
        setSearchResults(function (list) {
          if (!list) return list
          return list.map(function (c) { return String(c.chat_id) === String(chatId) ? Object.assign({}, c, { followed: followed }) : c })
        })
        setMsg(followed ? '已关注：同步后将识别该群待办' : '已取消关注')
      })

      function completeTodo(t) {
        if (!t || !t.key) return
        // 立即从列表移除（乐观更新），随后与服务端对账；完整详情随请求归档留存
        setTodos(function (list) { return list.filter(function (x) { return x.key !== t.key }) })
        const src = t.source || {}
        api(API.todoDone, {
          method: 'POST',
          body: {
            key: t.key,
            todo: t.todo || '',
            chat: src.chat || '',
            source: src,
            assignee: t.assignee || '',
            priority: t.priority || '',
            deadline: t.deadline || '',
          },
        })
          .then(function (r) {
            if (r.state && r.state.data && Array.isArray(r.state.data.todos)) setTodos(r.state.data.todos)
            setState(r.state)
            if (props.onUnreadChange && r.state && r.state.data) props.onUnreadChange(Number(r.state.data.unreadCount) || 0)
          })
          .catch(function (e) {
            setErr((e && e.message) || String(e))
            refresh()
          })
      }

      // 逐条标记已读：未读待办点「已读」→ 服务端写入 todoSeen，未读数减一
      function markSeen(t) {
        if (!t || !t.key) return
        api(API.todoSeen, { method: 'POST', body: { key: t.key } })
          .then(function (r) {
            // 乐观更新：本地立即把该条标为已读
            setTodos(function (list) {
              return list.map(function (x) { return x.key === t.key ? { ...x, seen: true } : x })
            })
            if (r.state) setState(r.state)
            if (props.onUnreadChange && r.state && r.state.data) props.onUnreadChange(Number(r.state.data.unreadCount) || 0)
            if (r.state && r.state.data && Array.isArray(r.state.data.todos)) setTodos(r.state.data.todos)
          })
          .catch(function (e) {
            setErr((e && e.message) || String(e))
            refresh()
          })
      }

      // 全部已读：当前所有待办一次标记
      function markAllSeen() {
        api(API.todoSeenAll, { method: 'POST', body: {} })
          .then(function (r) {
            if (r.state) setState(r.state)
            if (props.onUnreadChange && r.state && r.state.data) props.onUnreadChange(Number(r.state.data.unreadCount) || 0)
            if (r.state && r.state.data && Array.isArray(r.state.data.todos)) setTodos(r.state.data.todos)
          })
          .catch(function (e) {
            setErr((e && e.message) || String(e))
            refresh()
          })
      }

      // 撤回：把已完成的待办撤回到待办列表（重新未读）
      function restoreTodo(a) {
        if (!a || !a.key) return
        api(API.todoRestore, { method: 'POST', body: { key: a.key } })
          .then(function (r) {
            if (r.state) setState(r.state)
            if (props.onUnreadChange && r.state && r.state.data) props.onUnreadChange(Number(r.state.data.unreadCount) || 0)
            if (r.state && r.state.data && Array.isArray(r.state.data.todos)) setTodos(r.state.data.todos)
            setMsg('已撤回到待办列表')
          })
          .catch(function (e) {
            setErr((e && e.message) || String(e))
            refresh()
          })
      }

      function exportTodos() {
        try {
          const blob = new Blob([JSON.stringify(todos, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = 'feishu-todos.json'
          a.click()
          URL.revokeObjectURL(url)
        } catch (e) {
          setErr('导出失败: ' + (e && e.message))
        }
      }

      function renderChatRow(c) {
        const followed = Boolean(c.followed)
        const hasCount = typeof c.count === 'number' && c.count > 0
        const sub = followed
          ? (hasCount ? (c.count + ' 条消息') : '已关注（同步后拉取消息）')
          : (hasCount ? (c.count + ' 条消息 · 未关注') : '未关注')
        return el('div', { key: c.chat_id, className: 'ft-chat-row' + (followed ? ' ft-chat-row-followed' : '') },
          el('div', { className: 'ft-chat-info' },
            el('div', { className: 'ft-chat-name' }, c.name || c.chat_id),
            el('div', { className: 'ft-chat-count' }, sub)
          ),
          Btn({
            small: true,
            primary: !followed,
            label: followed ? '已关注' : '关注',
            onClick: function () { doFollow(c.chat_id, !followed) },
            disabled: Boolean(busy),
          })
        )
      }

      function AuthBlock() {
        const s = state
        return el('div', { className: 'ft-section' },
          el('div', { className: 'ft-section-title' }, '授权'),
          el('div', { className: 'ft-row' },
            el('span', { className: 'ft-k' }, '应用凭证'),
            s.auth.appConfigured
              ? el('span', { className: 'ft-v' }, Badge({ tone: 'green', label: '已配置 ' + s.auth.appIdMasked }))
              : el('span', { className: 'ft-v' }, Badge({ tone: 'red', label: '未配置' }))
          ),
          el('div', { className: 'ft-row' },
            el('span', { className: 'ft-k' }, '个人授权'),
            s.auth.userConfigured
              ? el('span', { className: 'ft-v' }, s.auth.userName || s.auth.userOpenId || '已授权')
              : el('span', { className: 'ft-v' }, Badge({ tone: 'gray', label: '未授权' }))
          ),
          s.auth.userConfigured ? el('div', { className: 'ft-row' },
            el('span', { className: 'ft-k' }, 'token 有效期'),
            el('span', { className: 'ft-v' },
              s.auth.tokenValid
                ? Badge({ tone: 'green', label: '剩余 ' + fmtMs(s.auth.tokenValidMs) })
                : Badge({ tone: 'red', label: '已过期' })
            )
          ) : null,
          el('div', { className: 'ft-actions' },
            Btn({ primary: true, label: '个人授权登录', onClick: doAuth, disabled: Boolean(busy) }),
            s.auth.hasRefreshToken ? Btn({ small: true, label: '刷新 token', onClick: doRefreshToken, disabled: Boolean(busy) }) : null,
            s.auth.userConfigured ? Btn({ small: true, danger: true, label: '撤销授权', onClick: doRevoke, disabled: Boolean(busy) }) : null
          ),
          authUrl ? el('div', null,
            el('a', { className: 'ft-todo-link', href: authUrl, target: '_blank', rel: 'noopener' }, '若未自动打开，点此完成飞书授权 →'),
            el('div', { className: 'ft-actions' }, Btn({ small: true, danger: true, label: '取消', onClick: doCancelAuth, disabled: Boolean(busy) }))
          ) : null,
          el('div', { className: 'ft-hint' }, 'App ID/Secret、AI 模型、时间窗口 请在「设置 → 插件 → 飞书待办」填写。')
        )
      }

      const s = state
      const tabs = [
        ['status', '状态'],
        ['todos', '待办'],
        ['chats', '群聊'],
      ]

      return el('div', { className: 'ft-overlay' },
        el('div', { className: 'ft-head' },
          el('span', { className: 'ft-title' }, '📋 飞书待办'),
          el('button', { className: 'ft-close', onClick: props.onClose }, '×')
        ),
        props.unread > 0 ? el('div', { className: 'ft-notify' },
          el('span', { className: 'ft-notify-text' }, '📌 ' + props.unread + ' 条未读待办（在待办页逐条标记已读）'),
          el('button', { className: 'ft-notify-btn', onClick: function () { setTab('todos') } }, '查看')
        ) : null,
        el('div', { className: 'ft-tabs' },
          tabs.map(function (t) {
            return el('button', {
              key: t[0],
              className: 'ft-tab' + (tab === t[0] ? ' ft-tab-active' : ''),
              onClick: function () { setTab(t[0]) },
            }, t[1])
          })
        ),
        el('div', { className: 'ft-body' },
          busy ? el('div', { className: 'ft-msg' }, '⏳ 处理中，请稍候…') : null,
          err ? el('div', { className: 'ft-err' }, err) : null,
          msg ? el('div', { className: 'ft-msg' }, msg) : null,

          tab === 'status' && s ? el('div', null,
            el(AuthBlock),
            el('div', { className: 'ft-section' },
              el('div', { className: 'ft-section-title' }, 'AI 模型'),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, '模型'),
                el('span', { className: 'ft-v' }, s.llm.model || '(未设置)')
              ),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, 'API'),
                el('span', { className: 'ft-v' }, s.llm.baseUrl || '(未设置)')
              )
            ),
            el('div', { className: 'ft-section' },
              el('div', { className: 'ft-section-title' }, '数据'),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, '最近同步'),
                el('span', { className: 'ft-v' }, s.data.fetchedAt ? fmtTime(s.data.fetchedAt) : '从未')
              ),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, '会话 / 消息'),
                el('span', { className: 'ft-v' }, s.data.chatsCount + ' 群 · ' + s.data.messagesCount + ' 条')
              ),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, '关注 / 待办'),
                el('span', { className: 'ft-v' }, (s.data.followedChats || []).length + ' 群 · ' + s.data.todosCount + ' 条')
              ),
              el('div', { className: 'ft-row' },
                el('span', { className: 'ft-k' }, '已完成'),
                el('span', { className: 'ft-v' }, s.data.completedCount + ' 条（不再出现在待办）')
              )
            ),
            el('div', { className: 'ft-actions' },
              Btn({ primary: true, label: '同步消息', onClick: doSync, disabled: Boolean(busy) }),
              Btn({ label: '识别待办', onClick: function () { doTodos(false) }, disabled: Boolean(busy) }),
              Btn({ label: '同步并识别', onClick: function () { doTodos(true) }, disabled: Boolean(busy) })
            )
          ) : null,

          tab === 'todos' ? el('div', null,
            el('div', { className: 'ft-seg' },
              el('button', { className: 'ft-seg-btn' + (!completedView ? ' ft-seg-active' : ''), onClick: function () { setCompletedView(false) } },
                '待办' + (s && s.data && s.data.todosCount ? ' (' + s.data.todosCount + ')' : '')),
              el('button', { className: 'ft-seg-btn' + (completedView ? ' ft-seg-active' : ''), onClick: function () { setCompletedView(true) } },
                '已完成' + (s && s.data && s.data.completedCount ? ' (' + s.data.completedCount + ')' : ''))
            ),
            completedView
              ? (function () {
                  const archive = (s && s.data && s.data.completed) || []
                  const cut = archiveCutoff(archiveRange)
                  const q = archiveQuery.trim().toLowerCase()
                  const shown = archive.filter(function (a) {
                    if (a.doneAt && cut && a.doneAt < cut) return false
                    if (q && !(String(a.todo || '').toLowerCase().indexOf(q) !== -1 || String(a.chat || '').toLowerCase().indexOf(q) !== -1 || String(a.assignee || '').toLowerCase().indexOf(q) !== -1)) return false
                    return true
                  })
                  return el('div', null,
                    el('div', { className: 'ft-tools' },
                      el('select', { className: 'ft-select', value: archiveRange, onChange: function (e) { setArchiveRange(e.target.value) }, title: '按完成时间筛选' },
                        ARCHIVE_RANGES.map(function (r) {
                          return el('option', { key: r[0], value: r[0] }, r[1])
                        })
                      ),
                      el('input', { className: 'ft-search ft-search-inline', type: 'text', placeholder: '搜索已完成待办（任务/群/负责人）…', value: archiveQuery, onChange: function (e) { setArchiveQuery(e.target.value) } })
                    ),
                    shown.length
                      ? el('div', null, shown.map(function (a) {
                          return el('div', { key: a.key, className: 'ft-todo' },
                            el('div', { className: 'ft-todo-head' },
                              el('div', { className: 'ft-todo-main' },
                                el('div', { className: 'ft-todo-title ft-todo-done' }, a.todo || a.key),
                                el('div', { className: 'ft-todo-meta' },
                                  fmtTime(a.doneAt) + (a.chat ? ' · ' + a.chat : '') + (a.assignee ? ' · 负责人 ' + a.assignee : '') + (a.priority ? ' · ' + a.priority : '')
                                )
                              ),
                              Btn({ small: true, label: '撤回', title: '撤回到待办列表（重新未读）', onClick: function () { restoreTodo(a) } })
                            )
                          )
                        }))
                      : el('div', { className: 'ft-empty' }, q ? '没有匹配「' + archiveQuery.trim() + '」的已完成待办。' : '该时间段内暂无已完成的待办。')
                  )
                })()
              : el('div', null,
                el('div', { className: 'ft-actions' },
                  Btn({ primary: true, label: '识别待办', onClick: function () { doTodos(false) }, disabled: Boolean(busy) }),
                  Btn({ label: '同步并识别', onClick: function () { doTodos(true) }, disabled: Boolean(busy) }),
                  todos && todos.length ? Btn({ small: true, label: '导出 JSON', onClick: exportTodos }) : null,
                  todos && todos.some(function (t) { return !t.seen }) ? Btn({ small: true, label: '全部已读', title: '把当前所有待办标记为已读', onClick: markAllSeen, disabled: Boolean(busy) }) : null
                ),
                todos && todos.length
                  ? el('div', null,
                    el('input', { className: 'ft-search', type: 'text', placeholder: '搜索待办（任务/群/负责人）…', value: todoQuery, onChange: function (e) { setTodoQuery(e.target.value) } }),
                    (function () {
                      const q = todoQuery.trim().toLowerCase()
                      const list = q
                        ? todos.filter(function (t) {
                            const src = t.source || {}
                            return String(t.todo || '').toLowerCase().indexOf(q) !== -1 ||
                              String(src.chat || '').toLowerCase().indexOf(q) !== -1 ||
                              String(t.assignee || '').toLowerCase().indexOf(q) !== -1
                          })
                        : todos
                      if (!list.length) return el('div', { className: 'ft-empty' }, '没有匹配「' + todoQuery.trim() + '」的待办。')
                      return el('div', null, list.map(function (t) {
                        const src = t.source || {}
                        const unread = !t.seen
                        return el('div', {
                          key: t.key || (src.chatId + '::' + t.todo),
                          className: 'ft-todo' + (unread ? ' ft-todo-unread' : ''),
                          title: unread ? '点击标记为已读（未读数减一）' : undefined,
                          onClick: function (e) {
                            if (t.seen) return
                            // 点复选框（标记完成）不触发「点击已读」
                            if (e && e.target && typeof e.target.closest === 'function' && e.target.closest('.ft-todo-check')) return
                            markSeen(t)
                          },
                        },
                          el('div', { className: 'ft-todo-head' },
                            el('input', { type: 'checkbox', className: 'ft-todo-check', checked: false, title: '标记完成（计入归档，后续识别不再出现）', onChange: function () { completeTodo(t) } }),
                            el('div', { className: 'ft-todo-main' },
                              el('div', { className: 'ft-todo-title' },
                                unread ? el('span', { className: 'ft-badge ft-badge-blue ft-todo-unread-badge' }, '未读') : null,
                                t.todo),
                              el('div', { className: 'ft-todo-meta' },
                                (t.priority ? '优先级 ' + t.priority : ''),
                                t.assignee ? ' · 负责人 ' + t.assignee : '',
                                t.deadline ? ' · 截止 ' + t.deadline : '',
                                t.mergedFrom && t.mergedFrom.length ? ' · 已合并 ' + t.mergedFrom.length + ' 条' : ''
                              ),
                              src.chat ? el('div', { className: 'ft-todo-meta' }, '来源: ' + src.chat + (src.time ? ' · ' + src.time : '')) : null
                            )
                          )
                        )
                      }))
                    })()
                  )
                  : el('div', { className: 'ft-empty' },
                      s && s.data.followedChats && s.data.followedChats.length
                        ? (s.data.messagesCount ? '尚未识别待办，点击上方按钮。' : '尚无消息，请先在「状态」页同步（只同步已关注群）。')
                        : '请先在「群聊」页搜索并关注要识别的群，再同步识别。')
              )
          ) : null,

          tab === 'chats' ? el('div', null,
            !s || !s.data.chats || !s.data.chats.length
              ? el('div', { className: 'ft-empty' }, '暂无群数据，请先在「状态」页「同步消息」拉取群列表。')
              : el('div', null,
                el('input', {
                  className: 'ft-search',
                  type: 'text',
                  placeholder: '搜索群名（服务端全量搜索，不受缓存上限影响）…',
                  value: chatQuery,
                  onChange: function (e) { setChatQuery(e.target.value) },
                }),
                chatQuery.trim()
                  ? el('div', null,
                      searchResults === null
                        ? el('div', { className: 'ft-empty' }, '搜索中…')
                        : searchResults.length
                          ? searchResults.map(renderChatRow)
                          : el('div', { className: 'ft-empty' }, '未找到匹配的群。')
                    )
                  : el('div', null,
                      el('label', { className: 'ft-only-followed' },
                        el('input', { type: 'checkbox', className: 'ft-set-check', checked: onlyFollowed, onChange: function (e) { setOnlyFollowed(e.target.checked) } }),
                        el('span', null, '只看已关注（' + (s.data.followedChats || []).length + '）')
                      ),
                      (function () {
                        const list = s.data.chats.filter(function (c) {
                          if (onlyFollowed && !c.followed) return false
                          return true
                        })
                        list.sort(function (a, b) { return (b.followed ? 1 : 0) - (a.followed ? 1 : 0) })
                        return list.length
                          ? el('div', null, list.map(renderChatRow))
                          : el('div', { className: 'ft-empty' }, '没有已关注的群，请在上方搜索并关注。')
                      })()
                    )
              )
          ) : null,

          !s && !busy ? el('div', { className: 'ft-empty' }, '加载中…') : null
        )
      )
    }

    // ------------------------------------------------------------------ App
    // 读取 FAB 上次拖放的位置（localStorage 持久化）
    function loadFabPos() {
      try {
        const raw = localStorage.getItem('dsh.ft.fabPos')
        if (!raw) return null
        const p = JSON.parse(raw)
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y }
      } catch (e) {}
      return null
    }

    function App() {
      const [open, setOpen] = React.useState(false)
      const [unread, setUnread] = React.useState(0)
      const [initialTab, setInitialTab] = React.useState('status')
      const [fabPos, setFabPos] = React.useState(loadFabPos)
      const [toastPos, setToastPos] = React.useState(null)
      // 拖拽状态：轻点（未拖动）在 pointerup 直接执行动作，click 只用于吞掉自动双触发
      const dragRef = React.useRef(null)
      const lastUp = React.useRef({ t: 0, acted: false })

      function beginDrag(e, opts) {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        const target = e.currentTarget
        const rect = target.getBoundingClientRect()
        dragRef.current = {
          moved: false,
          startX: e.clientX,
          startY: e.clientY,
          oLeft: rect.left,
          oTop: rect.top,
          w: rect.width,
          h: rect.height,
          setPos: opts.setPos || null,
          onMoved: opts.onMoved || null,
          onTap: opts.onTap || null,
        }
        try { target.setPointerCapture(e.pointerId) } catch (err) {}
      }

      function moveDrag(e) {
        const d = dragRef.current
        if (!d) return
        const dx = e.clientX - d.startX
        const dy = e.clientY - d.startY
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
        if (!d.moved) return
        const maxX = Math.max(0, window.innerWidth - 16 - d.w)
        const maxY = Math.max(0, window.innerHeight - 16 - d.h)
        const pos = { x: Math.min(Math.max(0, d.oLeft + dx), maxX), y: Math.min(Math.max(0, d.oTop + dy), maxY) }
        d.lastPos = pos
        if (d.setPos) d.setPos(pos)
      }

      function endDrag() {
        const d = dragRef.current
        if (!d) return
        dragRef.current = null
        if (d.moved) {
          lastUp.current = { t: Date.now(), acted: false }
          if (d.onMoved && d.lastPos) d.onMoved(d.lastPos)
        } else {
          // 轻点：直接执行动作（不依赖 click 是否派发）
          lastUp.current = { t: Date.now(), acted: true }
          if (d.onTap) d.onTap()
        }
      }

      // 吞掉「轻点/拖动后自动派发的 click」，避免双触发；陈旧标记视为真实点击（键盘等无 pointer 场景）
      function swallowTrailingClick() {
        const lu = lastUp.current
        if (!lu) return false
        if (Date.now() - lu.t < 800 && (lu.acted || lu.moved)) {
          lastUp.current = { t: 0, acted: false, moved: false }
          return true
        }
        lastUp.current = { t: 0, acted: false, moved: false }
        return false
      }

      // FAB 拖放后记住位置
      function saveFabPos(pos) {
        try { localStorage.setItem('dsh.ft.fabPos', JSON.stringify(pos)) } catch (err) {}
      }

      function togglePanel() {
        setInitialTab('status'); setOpen(function (v) { return !v })
      }

      function openTodos() {
        setInitialTab('todos'); setOpen(true)
      }

      function fetchUnread() {
        api(API.state).then(function (r) {
          setUnread((r.state && r.state.data && Number(r.state.data.unreadCount)) || 0)
        }).catch(function () {})
      }
      // 定时器只在 DSH 页面打开时运行；60s 轮询一次未读待办数（消息栏提示 + 角标）
      React.useEffect(function () {
        fetchUnread()
        const timer = setInterval(fetchUnread, 60000)
        return function () { clearInterval(timer) }
      }, [])

      // 消息栏提示条：存在未读待办时显示，可拖动；轻点 → 打开待办页查看
      const toast = unread > 0 ? el('div', {
        className: 'ft-toast',
        title: '轻点查看未读待办（可拖动）',
        style: toastPos ? { left: toastPos.x + 'px', top: toastPos.y + 'px', right: 'auto', bottom: 'auto' } : undefined,
        onPointerDown: function (e) { beginDrag(e, { setPos: setToastPos, onTap: openTodos }) },
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onClick: function () {
          if (swallowTrailingClick()) return
          openTodos()
        },
      },
        el('span', { className: 'ft-toast-text' }, '📌 飞书待办：' + unread + ' 条未读待办，轻点查看')
      ) : null

      return el('div', null,
        toast,
        el('div', {
          className: 'ft-fab-wrap',
          style: fabPos ? { left: fabPos.x + 'px', top: fabPos.y + 'px', right: 'auto', bottom: 'auto' } : undefined,
          onPointerDown: function (e) { beginDrag(e, { setPos: setFabPos, onMoved: saveFabPos, onTap: togglePanel }) },
          onPointerMove: moveDrag,
          onPointerUp: endDrag,
        },
          el('button', {
            className: 'ft-fab',
            title: '飞书待办' + (unread > 0 ? '（' + unread + ' 条未读待办）' : '') + '（可拖动）',
            onClick: function () {
              if (swallowTrailingClick()) return
              togglePanel()
            },
          }, '📋'),
          unread > 0 ? el('span', { className: 'ft-fab-badge', title: unread + ' 条未读待办' }, String(unread)) : null
        ),
        open ? el(Panel, { onClose: function () { setOpen(false) }, unread: unread, onUnreadChange: setUnread, initialTab: initialTab }) : null
      )
    }

    // ------------------------------------------------------------------ mount
    function injectCss() {
      const style = document.createElement('style')
      style.setAttribute('data-dsh-feishu-todo', '')
      style.textContent = CSS
      document.head.appendChild(style)
      return function () { style.remove() }
    }

    function mount() {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9980;'
      document.body.appendChild(host)
      const root = createRoot(host)
      root.render(el(App))
      return function () {
        root.unmount()
        host.remove()
      }
    }

    // ================================================================ 设置卡片
    // 官方「设置 → 插件 → 可配置」里的配置卡片：绑定 feishu-todo 设置命名空间，
    // 编辑并保存 8 个配置字段。经 settings.plugin.item（keyed，key 即命名空间）
    // slot 注册，locale 提供标题/标签。宿主半边 installSettingsSection 负责注册
    // 命名空间与 schema，本半边只渲染这张卡片并回写。

    const SETTINGS_FIELDS = [
      { key: 'enabled', type: 'boolean' },
      { key: 'appId', type: 'text' },
      { key: 'appSecret', type: 'password' },
      { key: 'redirectUri', type: 'text' },
      { key: 'llmBaseUrl', type: 'text' },
      { key: 'llmApiKey', type: 'password' },
      { key: 'llmModel', type: 'text' },
      { key: 'days', type: 'number' },
      { key: 'mergeTodos', type: 'boolean' },
      { key: 'scheduleEnabled', type: 'boolean' },
      { key: 'scheduleIntervalMin', type: 'number' },
      { key: 'scheduleNotify', type: 'boolean' },
    ]

    const ZH_SETTINGS = {
      title: '飞书待办',
      description: '飞书消息待办识别：配置飞书应用信息与 AI 模型（保存后立即生效）。',
      enabled: '启用',
      enabledHint: '关闭后暂停同步与待办识别。',
      appId: 'App ID',
      appIdHint: '飞书自建应用的 App ID（cli_ 开头）。',
      appSecret: 'App Secret',
      appSecretHint: '飞书自建应用的 App Secret，用于获取 tenant_access_token。',
      redirectUri: 'OAuth 回调地址',
      redirectUriHint: '个人授权跳转回填地址，需与飞书应用后台「安全设置」一致。',
      llmBaseUrl: 'LLM 接口地址',
      llmBaseUrlHint: 'OpenAI 兼容接口，如 https://tokenrhythm.studio/v1。',
      llmApiKey: 'LLM API Key',
      llmApiKeyHint: 'OpenAI 兼容接口的密钥。',
      llmModel: 'LLM 模型',
      llmModelHint: '模型名，如 deepseek-v4-flash-0731。',
      days: '同步天数',
      daysHint: '读取最近几天的消息（1–30）。',
      mergeTodos: '待办合并总结',
      mergeTodosHint: '提取后把同一件事的琐碎小待办合并成一条概括性待办（减少数量）。',
      scheduleEnabled: '定时自动同步识别',
      scheduleEnabledHint: '开启后按下方间隔自动「同步并识别」关注群的待办。',
      scheduleIntervalMin: '调度间隔（分钟）',
      scheduleIntervalMinHint: '每 N 分钟自动运行一次（最小 5 分钟）。',
      scheduleNotify: '新增待办提醒',
      scheduleNotifyHint: '定时识别发现新增待办时，在右下角按钮上显示提醒角标。',
      unsaved: '未保存',
      save: '保存',
      discard: '放弃',
      loading: '正在加载配置…',
      unavailable: '当前环境未提供该设置项。',
    }

    const EN_SETTINGS = {
      title: 'Feishu Todo',
      description: 'Feishu message todo recognition: configure the Feishu app and the AI model (saves apply immediately).',
      enabled: 'Enabled',
      enabledHint: 'When off, sync and todo recognition pause.',
      appId: 'App ID',
      appIdHint: 'The Feishu custom app App ID (starts with cli_).',
      appSecret: 'App Secret',
      appSecretHint: 'The Feishu custom app secret, used for the tenant_access_token.',
      redirectUri: 'OAuth redirect URI',
      redirectUriHint: 'The personal-authorization callback URI; must match the app console security settings.',
      llmBaseUrl: 'LLM base URL',
      llmBaseUrlHint: 'An OpenAI-compatible endpoint, e.g. https://tokenrhythm.studio/v1.',
      llmApiKey: 'LLM API key',
      llmApiKeyHint: 'The OpenAI-compatible endpoint key.',
      llmModel: 'LLM model',
      llmModelHint: 'Model name, e.g. deepseek-v4-flash-0731.',
      days: 'Sync days',
      daysHint: 'Read messages from the last N days (1–30).',
      mergeTodos: 'Merge & summarize todos',
      mergeTodosHint: 'Merge trivial sub-steps of the same task into one summarized todo after extraction.',
      scheduleEnabled: 'Scheduled sync & recognize',
      scheduleEnabledHint: 'When on, automatically run sync+recognize for followed chats on the interval below.',
      scheduleIntervalMin: 'Schedule interval (min)',
      scheduleIntervalMinHint: 'Run automatically every N minutes (min 5).',
      scheduleNotify: 'New-todo notification',
      scheduleNotifyHint: 'Show a badge on the floating button when scheduled runs find new todos.',
      unsaved: 'Unsaved',
      save: 'Save',
      discard: 'Discard',
      loading: 'Loading settings…',
      unavailable: 'This settings item is not available here.',
    }

    function createMiniStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: function () { return snapshot },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () { listeners.delete(listener) }
        },
        set: function (next) {
          snapshot = next
          listeners.forEach(function (fn) { fn() })
        },
      }
    }

    function coerceFieldValue(field, raw) {
      if (field === 'days' || field === 'scheduleIntervalMin') {
        if (raw === '' || raw == null) return null
        const n = Number(raw)
        if (field === 'scheduleIntervalMin') return Number.isFinite(n) && n >= 5 ? n : 5
        return Number.isFinite(n) && n >= 1 ? n : 1
      }
      if (field === 'enabled' || field === 'scheduleEnabled' || field === 'scheduleNotify' || field === 'mergeTodos') return !!raw
      return raw == null ? '' : String(raw)
    }

    function makeFeishoTodoCard(scope) {
      let status = 'loading'
      let writable = false
      let base = null
      let staged = {}
      const store = createMiniStore({ status: 'loading', writable: false, value: null, dirty: false })

      function publish() {
        const value = {}
        if (base && typeof base === 'object') {
          Object.keys(base).forEach(function (k) { value[k] = base[k] })
        }
        Object.keys(staged).forEach(function (k) {
          if (staged[k] == null) delete value[k]
          else value[k] = staged[k]
        })
        store.set({ status: status, writable: writable, value: value, dirty: Object.keys(staged).length > 0 })
      }

      const offScope = scope.subscribe(function () {
        const s = scope.getSnapshot()
        if (s.status === 'ready') {
          base = (s.value && typeof s.value === 'object') ? s.value : {}
          status = 'ready'
          writable = s.writable !== false
          publish()
        } else if (s.status === 'unavailable') {
          base = null
          status = 'unavailable'
          writable = false
          publish()
        }
      })
      // 兼容不同 DSH 版本的 settingsScope scope 契约：部分版本无 load()，
      // 订阅后由宿主自动同步初值（useSyncExternalStore 标准行为）
      if (typeof scope.load === 'function') scope.load()

      function edit(field, raw) {
        const next = Object.assign({}, staged)
        next[field] = coerceFieldValue(field, raw)
        staged = next
        publish()
      }
      function discard() {
        staged = {}
        publish()
      }
      async function save() {
        const fields = Object.keys(staged)
        if (fields.length === 0) return
        for (let i = 0; i < fields.length; i++) {
          const field = fields[i]
          const v = staged[field]
          try {
            if (v == null) await scope.unset(field)
            else await scope.set(field, v)
          } catch (e) {
            // 写入失败交给 scope 的恢复读兜底
          }
        }
        staged = {}
        // 保存后由 scope 订阅带出最新 base，这里不再手动 publish，避免与写入竞态
      }

      return {
        inject: function () {
          return { hooks: { feishoTodoSettings: store }, save: save, discard: discard, edit: edit }
        },
        dispose: function () {
          try { offScope() } catch (e) {}
        },
      }
    }

    function FeishoTodoCard(props) {
      const t = props.t
      const state = props.useFeishoTodoSettings(function (s) { return s })
      const openPair = React.useState(false)
      const open = openPair[0]
      const setOpen = openPair[1]
      const val = state.value || {}
      const disabled = !state.writable

      // 命名空间不可用时不渲染（与官方 PluginCard 一致，避免占位）
      if (state.status === 'unavailable') return null

      const rows = SETTINGS_FIELDS.map(function (f) {
        const label = t(f.key)
        const hint = t(f.key + 'Hint')
        if (f.type === 'boolean') {
          return el('label', { className: 'ft-set-row ft-set-row-bool', key: f.key },
            el('span', { className: 'ft-set-label' }, label),
            el('input', {
              type: 'checkbox',
              className: 'ft-set-check',
              checked: !!val[f.key],
              disabled: disabled,
              onChange: function (e) { props.edit(f.key, e.target.checked) },
            }),
            hint ? el('p', { className: 'ft-set-hint' }, hint) : null,
          )
        }
        return el('label', { className: 'ft-set-row', key: f.key },
          el('span', { className: 'ft-set-label' }, label),
          el('input', {
            className: 'ft-set-input',
            type: f.type,
            value: val[f.key] == null ? '' : String(val[f.key]),
            disabled: disabled,
            onChange: function (e) { props.edit(f.key, e.target.value) },
          }),
          hint ? el('p', { className: 'ft-set-hint' }, hint) : null,
        )
      })

      const header = el('button', {
        type: 'button',
        className: 'ft-card-header',
        'aria-expanded': open,
        onClick: function () { setOpen(!open) },
      },
        el('span', { className: 'ft-card-head-text' },
          el('span', { className: 'ft-card-title' }, t('title')),
          el('span', { className: 'ft-card-desc' }, t('description')),
        ),
        state.dirty ? el('span', { className: 'ft-card-pending' }, t('unsaved')) : null,
        el('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          className: open ? 'ft-card-chevron ft-card-chevron-open' : 'ft-card-chevron',
          'aria-hidden': true,
        },
          el('path', {
            d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
            fill: 'currentColor',
          }),
        ),
      )

      const body = open ? el('div', { className: 'ft-card-body' },
        rows,
        el('div', { className: 'ft-card-actions' },
          el('button', {
            type: 'button',
            className: 'ft-btn ft-btn-primary ft-btn-small',
            disabled: disabled || !state.dirty,
            onClick: function () { props.save() },
          }, t('save')),
          el('button', {
            type: 'button',
            className: 'ft-btn ft-btn-small',
            disabled: disabled || !state.dirty,
            onClick: function () { props.discard() },
          }, t('discard')),
        ),
      ) : null

      return el('li', { className: open ? 'ft-card ft-card-open' : 'ft-card' }, header, body)
    }

    exports.inject = ['slots', 'settingsScope', 'locale', 'connection', 'remote']
    exports.apply = apply

    function apply(ctx) {
      // 设置卡片（官方「插件 → 可配置」）；best-effort，失败不影响浮动面板
      try {
        registerSettingsSurface(ctx)
      } catch (error) {
        console.warn('[dsh-feishu-todo] settings card failed:', error)
      }

      // 浮动面板（原有）
      let disposeCss = function () {}
      let disposeMount = function () {}
      try {
        disposeCss = injectCss()
        disposeMount = mount()
      } catch (error) {
        console.warn('[dsh-feishu-todo] mount failed:', error)
      }
      ctx.effect(function () {
        return function () {
          try { disposeMount() } catch (e) {}
          try { disposeCss() } catch (e) {}
        }
      }, 'dsh-feishu-todo: ui')
    }

    function registerSettingsSurface(ctx) {
      const slots = ctx.slots
      const settingsScope = ctx.settingsScope
      const locale = ctx.locale

      ctx.effect(function () {
        return locale.register('feishu-todo', { zh: ZH_SETTINGS, en: EN_SETTINGS })
      }, 'dsh-feishu-todo: settings locale')

      const controller = makeFeishoTodoCard(settingsScope.bind({ namespace: 'feishu-todo' }))

      slots.inject('settings.plugin.item', function () {
        const unregister = slots.register({
          name: 'settings.plugin.item',
          key: 'feishu-todo',
          locale: 'feishu-todo',
          inject: function () { return controller.inject() },
        }, FeishoTodoCard)
        return function () {
          try { controller.dispose() } catch (e) {}
          try { unregister() } catch (e) {}
        }
      })
    }

    return module.exports
  },
})