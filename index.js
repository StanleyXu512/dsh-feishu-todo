'use strict'

/**
 * dsh-feishu-todo — 宿主半边（Node 进程）。
 *
 * 挂载：
 * - 飞书引擎（原生 fetch：tenant/user token、群列表、历史消息、OAuth 换取/刷新）
 * - AI 待办识别（外部 OpenAI 兼容 LLM，带 5xx/限流/超时重试）
 * - /api/feishu-todo/* 路由族（浏览器半边 fetch 调用，同源）
 * - 设置页自动表单（schemastery 配置校验，installSettingsSection 注册）
 *
 * 配置（应用凭证 / LLM / 时间窗口）与个人授权 token 都走 DSH 设置服务
 * （设置 → 插件 → 飞书待办），持久化由设置服务负责，不写自定义 JSON 配置文件；
 * 仅「消息/待办」缓存存 ~/.dsh/feishu-todo-data.json。全部走官方 NPM SDK 包，不改 dsh 源码。
 */

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FeishuClient, buildAuthorizeUrl } from './src/feishu.js'
import { extractTodos, normTodoText, dedupTodosVsArchive, mergeTodosSummary, askTodos, planTodosAction, senderDisplayName } from './src/analyze.js'
import { extractMessageText } from './src/content.js'
import { loadData, saveData, emptyData } from './src/store.js'
import { DEFAULTS, mergeConfig, readConfigFile, buildScopeString, structuredCloneSafe } from './src/config.js'
import { generateCodeVerifier, codeChallengeS256, randomHex, maskSecret, nowSec, mapLimit, formatClock } from './src/util.js'

/** Stable cordis plugin name. */
export const name = 'feishu-todo'

/** Services required before the surfaces can mount. */
export const inject = ['webServer']

/** Settings namespace the web settings surface edits. */
export const FEISHU_TODO_SETTINGS_NS = settingsNamespace('feishu-todo')

/** Plugin config（可编辑子集），由同名 schemastery schema 校验。 */
export const Config = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  redirectUri: z.string().default(''),
  llmBaseUrl: z.string().default('https://api.openai.com/v1'),
  llmApiKey: z.string().default(''),
  llmModel: z.string().default('gpt-4o-mini'),
  days: z.number().min(1).default(7),
  // 识别优化：提取后 AI 聚合合并同类琐碎待办
  mergeTodos: z.boolean().default(true),
  // 定时调度：自动「同步并识别」，识别出新增待办时留提醒标记
  scheduleEnabled: z.boolean().default(false),
  scheduleIntervalMin: z.number().min(5).default(60),
  scheduleNotify: z.boolean().default(true),
})

/** 个人授权 token 状态命名空间（OAuth 流程写入，不在表单暴露，持久化由设置服务负责）。 */
export const FEISHU_TODO_AUTH_NS = settingsNamespace('feishu-todo-auth')

/** 个人授权 token 状态（非手填子集）。 */
const AuthState = z.object({
  accessToken: z.string().default(''),
  refreshToken: z.string().default(''),
  expiresAt: z.number().default(0),
  refreshExpiresAt: z.number().default(0),
  openId: z.string().default(''),
  name: z.string().default(''),
  avatarUrl: z.string().default(''),
  scope: z.string().default(''),
})

// 旧版（v0.2.x）配置文件的迁移源与迁移标记。迁移后改名为 *.migrated，不再读取。
const LEGACY_CONFIG_PATH = () => path.join(os.homedir(), '.dsh', 'feishu-todo.json')
const LEGACY_MIGRATED_PATH = () => path.join(os.homedir(), '.dsh', 'feishu-todo.json.migrated')
const DATA_PATH = () => path.join(os.homedir(), '.dsh', 'feishu-todo-data.json')

const OAUTH_PORT = 8765
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

/** 全局运行时状态（宿主进程内，一次 MUTEX 到简单对象）。 */
const state = {
  dataJson: null, // 消息缓存 / 待办（非配置）
}

// 设置服务解析值来源（installSettingsSection 挂接）。
let configSource = () => ({}) // 可编辑配置（应用凭证 / LLM / 时间窗口）
let authSource = () => ({}) // 个人授权 token 状态
// apply 时注入的上下文，仅用于把 OAuth token 写回设置服务。
let settingsCtx = null

/** 一次 OAuth 会话。 */
let oauth = null

// ---------------------------------------------------------------------------
// 配置映射：设置服务（可编辑 schema + token 状态）→ 引擎完整配置
// ---------------------------------------------------------------------------

/** 完整引擎配置 → 设置页可编辑 schema 值（也用于旧 JSON 配置的一次性迁移）。 */
function toSchemaValue(full) {
  return {
    enabled: true,
    appId: (full.auth && full.auth.appId) || '',
    appSecret: (full.auth && full.auth.appSecret) || '',
    redirectUri: (full.auth && full.auth.redirectUri) || '',
    llmBaseUrl: (full.llm && full.llm.baseUrl) || 'https://api.openai.com/v1',
    llmApiKey: (full.llm && full.llm.apiKey) || '',
    llmModel: (full.llm && full.llm.model) || 'gpt-4o-mini',
    days: Number(full.sync && full.sync.days) || 7,
    mergeTodos: full.sync ? full.sync.mergeTodos !== false : true,
    scheduleEnabled: Boolean(full.schedule && full.schedule.enabled),
    scheduleIntervalMin: Number(full.schedule && full.schedule.intervalMin) || 60,
    scheduleNotify: full.schedule ? full.schedule.notify !== false : true,
  }
}

/** schema 可编辑值 + token 状态 -> 引擎用完整配置（每次调用返回新对象）。 */
function buildFullConfig(schemaValue, authState) {
  const full = mergeConfig(structuredCloneSafe(DEFAULTS), {})
  const sv = schemaValue || {}
  const au = authState || {}
  full.auth.appId = sv.appId || ''
  if (sv.appSecret) full.auth.appSecret = sv.appSecret
  if (sv.redirectUri) full.auth.redirectUri = sv.redirectUri
  full.llm.baseUrl = sv.llmBaseUrl || full.llm.baseUrl
  if (sv.llmApiKey) full.llm.apiKey = sv.llmApiKey
  full.llm.model = sv.llmModel || full.llm.model
  if (Number(sv.days) > 0) full.sync.days = Number(sv.days)
  full.sync.mergeTodos = sv.mergeTodos !== false
  full.schedule.enabled = Boolean(sv.scheduleEnabled)
  full.schedule.intervalMin = Math.max(5, Number(sv.scheduleIntervalMin) || 60)
  full.schedule.notify = sv.scheduleNotify !== false
  full.auth.user = {
    accessToken: au.accessToken || '',
    refreshToken: au.refreshToken || '',
    expiresAt: Number(au.expiresAt) || 0,
    refreshExpiresAt: Number(au.refreshExpiresAt) || 0,
    openId: au.openId || '',
    name: au.name || '',
    avatarUrl: au.avatarUrl || '',
    scope: au.scope || '',
  }
  return full
}

/** 当前引擎用完整配置（实时读设置服务）。 */
function fullConfig() {
  return buildFullConfig(configSource() || {}, authSource() || {})
}

/** 由 token 对象生成设置服务的 auth patch（兼容驼峰/下划线两种键）。 */
function authPatchFromTokens(tokens) {
  const t = tokens || {}
  return {
    accessToken: t.accessToken || t.access_token || '',
    refreshToken: t.refreshToken || t.refresh_token || '',
    expiresAt: Number(t.expiresAt || 0),
    refreshExpiresAt: Number(t.refreshExpiresAt || 0),
    openId: t.openId || '',
    name: t.name || '',
    avatarUrl: t.avatarUrl || '',
    scope: t.scope || '',
  }
}

/** 取设置服务（可选能力，用 ctx.get 而非 ctx.settings 直取，后者会被 Cordis 代理拦截）。 */
function settingsService() {
  if (!settingsCtx) return undefined
  return settingsCtx.get('settings', false)
}

/** 把 OAuth token 写回设置服务（若有设置服务）。 */
async function persistAuthUser(patch) {
  const settings = settingsService()
  if (!settings) return
  await settings.update(FEISHU_TODO_AUTH_NS, authPatchFromTokens(patch))
}

/** 构造 FeishuClient，自动刷新 token 后回写设置服务。 */
function makeClient(cfg) {
  return new FeishuClient(cfg, {
    onUserTokenRefreshed: async (nextUser) => {
      await persistAuthUser(nextUser)
    },
  })
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t && t.unref) t.unref()
  })
}

/** 一次性迁移：旧版 ~/.dsh/feishu-todo.json → 设置服务（迁移后改名为 *.migrated）。 */
async function migrateLegacyConfig() {
  const settings = settingsService()
  if (!settings) return
  let old
  try {
    if (!fs.existsSync(LEGACY_CONFIG_PATH())) return
    old = readConfigFile(LEGACY_CONFIG_PATH())
  } catch {
    return
  }
  const full = mergeConfig(structuredCloneSafe(DEFAULTS), old || {})
  const u = (full.auth && full.auth.user) || {}
  await settings.update(FEISHU_TODO_SETTINGS_NS, toSchemaValue(full))
  await settings.update(FEISHU_TODO_AUTH_NS, authPatchFromTokens(u))
  try {
    fs.renameSync(LEGACY_CONFIG_PATH(), LEGACY_MIGRATED_PATH())
  } catch {
    // 改名失败不影响迁移结果，仅可能下次重复迁移（幂等，可接受）。
  }
}

// ---------------------------------------------------------------------------
// 路由助手
// ---------------------------------------------------------------------------

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

function htmlPage(title, body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f6f7">
<div style="background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center">
<h2 style="margin:0 0 8px;color:#222">${title}</h2><p style="color:#666;margin:0">${body}</p></div></body></html>`
}

function findFreePort(startPort) {
  return new Promise((resolve) => {
    let port = startPort
    const tryListen = () => {
      const srv = http.createServer()
      srv.once('error', () => {
        if (port - startPort < 20) {
          port++
          tryListen()
        } else {
          resolve(0)
        }
      })
      srv.once('listening', () => {
        srv.close(() => resolve(port))
      })
      srv.listen(port, '127.0.0.1')
    }
    tryListen()
  })
}

// ---------------------------------------------------------------------------
// OAuth 个人授权（本地回调服务器，非阻塞：路由返回授权链接，后台换 token）
// ---------------------------------------------------------------------------

async function startOauth() {
  const cfg = fullConfig()
  const auth = cfg.auth
  if (!auth.appId || !auth.appSecret) {
    throw new Error('请先在设置页填写 App ID 和 App Secret。')
  }

  const stateStr = randomHex(16)
  const verifier = auth.pkce !== false ? generateCodeVerifier() : ''
  const challenge = verifier ? codeChallengeS256(verifier) : ''
  const scope = buildScopeString(cfg)

  let port = OAUTH_PORT
  let redirectUri
  const customLocal = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)\/oauth\/callback/.exec(auth.redirectUri || '')
  if (customLocal) {
    port = Number(customLocal[2])
    redirectUri = auth.redirectUri
  } else {
    port = await findFreePort(OAUTH_PORT)
    if (!port) throw new Error('无法在本地找到可用回调端口，请检查端口占用。')
    redirectUri = `http://127.0.0.1:${port}/oauth/callback`
  }

  const authorizeUrl = buildAuthorizeUrl(cfg, { redirectUri, scope, state: stateStr, codeChallenge: challenge })

  const session = {
    state: stateStr,
    verifier,
    redirectUri,
    authorizeUrl,
    port,
    status: 'waiting', // waiting | authorized | done | error
    error: null,
    code: null,
    server: null,
    startedAt: Date.now(),
  }

  session.server = http.createServer((req, res) => {
    const u = new URL(req.url, redirectUri)
    if (u.pathname !== '/oauth/callback') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlPage('404', '路径不存在'))
      return
    }
    const errParam = u.searchParams.get('error')
    const code = u.searchParams.get('code')
    const stateBack = u.searchParams.get('state')
    if (errParam) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlPage('授权失败', `用户拒绝了授权（${errParam}）。`))
      session.status = 'error'
      session.error = errParam
      return
    }
    if (!code || stateBack !== stateStr) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlPage('校验失败', 'state 不匹配或缺少 code。'))
      session.status = 'error'
      session.error = 'state_mismatch'
      return
    }
    session.code = code
    session.status = 'authorized'
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(htmlPage('授权成功', '已获取授权码，可关闭本页回到应用。'))
    // 后台换取 token（不阻塞回调响应）
    exchangeCodeInBackground(session)
  })
  session.server.once('error', (e) => {
    session.status = 'error'
    session.error = String(e && e.message)
  })

  await new Promise((resolve, reject) => {
    session.server.once('listening', resolve)
    session.server.listen(port, '127.0.0.1')
  })

  if (oauth) {
    try { oauth.server.close() } catch (e) {}
  }
  oauth = session

  // 超时兜底
  setTimeout(() => {
    if (oauth === session && session.status === 'waiting') {
      session.status = 'error'
      session.error = 'timeout'
      try { session.server.close() } catch (e) {}
      oauth = null
    }
  }, OAUTH_TIMEOUT_MS).unref()

  return { authorizeUrl, port }
}

async function exchangeCodeInBackground(session) {
  try {
    const cfg = fullConfig()
    const client = makeClient(cfg)
    const tok = await client.exchangeCode({
      code: session.code,
      redirectUri: session.redirectUri,
      codeVerifier: session.verifier || undefined,
    })
    const now = Date.now()
    const cur = (cfg.auth && cfg.auth.user) || {}
    const nextUser = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || cur.refreshToken || '',
      expiresAt: now + (tok.expires_in || 7200) * 1000,
      refreshExpiresAt: tok.refresh_token_expires_in ? now + tok.refresh_token_expires_in * 1000 : (cur.refreshExpiresAt || 0),
      openId: cur.openId || '',
      name: cur.name || '',
      avatarUrl: cur.avatarUrl || '',
      scope: tok.scope || cur.scope || '',
    }
    let info = {}
    try { info = await client.getUserInfo(tok.access_token) } catch (e) {}
    if (info.open_id) nextUser.openId = info.open_id
    if (info.name) nextUser.name = info.name
    if (info.avatar_url) nextUser.avatarUrl = info.avatar_url
    await persistAuthUser(nextUser)
    session.status = 'done'
  } catch (e) {
    session.status = 'error'
    session.error = String(e && e.message) || String(e)
  } finally {
    try { session.server.close() } catch (e) {}
    if (oauth === session) oauth = null
  }
}

// ---------------------------------------------------------------------------
// 同步（拉群 + 拉消息）与 AI 待办
// ---------------------------------------------------------------------------

/** 待办稳定键：来源群 + 规范化文本。用于跨轮「已完成」去重。 */
function todoKey(t) {
  const chatId = (t && t.source && t.source.chatId) || ''
  return `${chatId}::${normTodoText(t && t.todo)}`
}

/** 按 message_id 去重合并两批消息，裁掉滚出时间窗的旧消息，按 create_time 升序返回。 */
function mergeMessages(prev, next, startSec, endSec) {
  const toSec = (v) => Math.floor((Number(v) || 0) / 1000) // create_time 是毫秒，窗口是秒
  const byId = new Map()
  for (const m of prev) {
    const t = toSec(m && m.create_time)
    if (t < startSec || t > endSec) continue
    const id = (m && m.message_id) || ''
    if (id) byId.set(id, m)
  }
  for (const m of next) {
    const id = (m && m.message_id) || ''
    if (id) byId.set(id, m)
  }
  const out = Array.from(byId.values())
  out.sort((a, b) => (Number(a && a.create_time) || 0) - (Number(b && b.create_time) || 0))
  return out
}

async function doSync() {
  const cfg = fullConfig()
  const client = makeClient(cfg)
  const days = Number(cfg.sync.days) || 7
  const startSec = nowSec() - days * 86400
  const endSec = nowSec()

  // 群列表是轻量接口，全部拉取用于「群聊」页搜索 + 关注；消息仅拉取已关注群。
  const chats = await client.listAllChats(cfg.sync.maxChats || 200)
  const exclude = new Set((cfg.sync.excludeChatIds || []).filter(Boolean).map(String))
  const extra = (cfg.sync.chatIds || []).filter(Boolean).map(String)
  const targets = []
  for (const c of chats) {
    if (!exclude.has(String(c.chat_id))) targets.push(c)
  }
  for (const id of extra) {
    if (!targets.some((t) => String(t.chat_id) === id)) targets.push({ chat_id: id, name: id })
  }

  const data = state.dataJson || emptyData()
  // 增量判定：只有时间窗未向前扩展（days 未增大）时才走增量，否则全量重拉
  const prevStart = Number(data.window && data.window.startSec) || 0
  const canIncremental = prevStart > 0 && startSec >= prevStart
  const overlapSec = Number(cfg.sync.incrementalOverlapSec) || 60

  const followed = new Set((data.followedChats || []).map(String))
  const next = emptyData()
  next.chats = []
  next.messages = {}
  next.memberNames = {}
  let messagesTotal = 0
  let newMessagesTotal = 0
  const errors = []

  // 1) 群列表（轻量，全部保留用于搜索/浏览）
  for (const chat of targets) {
    const chatId = String(chat.chat_id)
    next.chats.push({ chat_id: chatId, name: chat.name || chatId })
  }

  // 2) 仅对已关注群拉消息：优先增量（只拉上次之后的新消息），否则全量
  const followedTargets = targets.filter((c) => followed.has(String(c.chat_id)))
  const syncConcurrency = Number(cfg.sync.concurrency) || 4
  await mapLimit(followedTargets, syncConcurrency, async (chat) => {
    const chatId = String(chat.chat_id)
    const chatName = chat.name || chatId

    const cached = (data.messages && data.messages[chatId]) || []
    const cachedMaxMs = cached.reduce((m, x) => Math.max(m, Number(x.create_time) || 0), 0)
    const cachedMaxSec = Math.floor(cachedMaxMs / 1000) // create_time 毫秒 -> 秒
    let fetchStartSec = startSec
    let base = []
    if (canIncremental && cachedMaxSec > 0) {
      fetchStartSec = Math.max(startSec, cachedMaxSec - overlapSec)
      base = cached
    }

    let fetched = []
    try {
      fetched = await client.getAllMessages(chatId, {
        startSec: fetchStartSec,
        endSec,
        max: cfg.sync.maxMessagesPerChat || 2000,
      })
    } catch (e) {
      errors.push(`${chatName}: ${(e && e.message) || e}`)
      fetched = []
    }

    const merged = mergeMessages(base, fetched, startSec, endSec)
    next.messages[chatId] = merged
    newMessagesTotal += fetched.length
    messagesTotal += merged.length

    // 成员名：仅在需要时拉取（有新增消息且有未解析的发送者，或无任何缓存时）
    const cachedNames = (data.memberNames && data.memberNames[chatId]) || {}
    let namesForChat = cachedNames
    if (cfg.sync.fetchMemberNames !== false && fetched.length > 0) {
      const needNames = (Object.keys(cachedNames).length === 0 && merged.length > 0) ||
        fetched.some((m) => {
          const id = (m && m.sender && m.sender.id) || ''
          return id && !cachedNames[id]
        })
      if (needNames) {
        try {
          namesForChat = Object.assign({}, cachedNames, await client.fetchMemberNames(chatId))
        } catch (e) {
          namesForChat = cachedNames
        }
      }
    }
    next.memberNames[chatId] = namesForChat
  })

  next.fetchedAt = Date.now()
  next.updatedAt = Date.now()
  next.window = { days, startSec, endSec }
  next.todos = data.todos || []
  next.todosGeneratedAt = data.todosGeneratedAt || 0
  next.followedChats = data.followedChats || []
  next.completedTodos = data.completedTodos || {}
  next.todoSeen = data.todoSeen || {} // 关键：识别产生的已读标记不能丢
  next.lastNotify = data.lastNotify || null
  next.version = 1

  saveData(DATA_PATH(), next)
  state.dataJson = next
  return {
    chats: next.chats.length,
    followed: next.followedChats.length,
    messages: messagesTotal,
    newMessages: newMessagesTotal,
    incremental: canIncremental,
    window: next.window,
    errors,
  }
}

/** 关注/取消关注某个群（持久化到数据文件）。 */
async function setFollow(chatId, followed) {
  const data = state.dataJson || emptyData()
  let list = (data.followedChats || []).map(String)
  const id = String(chatId || '')
  const has = list.includes(id)
  if (followed && !has) list.push(id)
  if (!followed && has) list = list.filter((x) => x !== id)
  data.followedChats = list
  saveData(DATA_PATH(), data)
  state.dataJson = data
  return list
}

/** 标记某条待办已完成：整条记录（含详情）归档到 completedTodos 留存，并从当前列表移除；后续识别不再出现（按 key 去重）。 */
async function markTodoDone(key, details) {
  key = String(key || '')
  const data = state.dataJson || emptyData()
  const completed = Object.assign({}, data.completedTodos || {})
  const rec = Object.assign({}, details || {})
  rec.todo = String(rec.todo || '')
  rec.source = rec.source && typeof rec.source === 'object' ? rec.source : {}
  rec.doneAt = Date.now()
  completed[key] = rec
  data.completedTodos = completed
  data.todos = (data.todos || []).filter((t) => todoKey(t) !== key)
  saveData(DATA_PATH(), data)
  state.dataJson = data
  return data.todos
}

/** AI 助手：按编号（第 N 条 / N）或原文匹配待办 */
function findTodoByRef(todos, ref) {
  const text = String(ref || '').trim()
  if (!text) return null
  const m = text.match(/第?\s*(\d{1,3})\s*条?/)
  if (m) {
    const i = Number(m[1]) - 1
    if (i >= 0 && i < todos.length) return { todo: todos[i], via: '编号' }
  }
  const norm = normTodoText(text)
  if (!norm) return null
  const hits = todos.filter((t) => {
    const tn = normTodoText(t && t.todo)
    return tn === norm || tn.includes(norm) || norm.includes(tn)
  })
  if (hits.length === 1) return { todo: hits[0], via: '文本' }
  if (hits.length > 1) return { multiple: hits.map((t) => String(t.todo || '')) }
  return null
}

/** AI 助手：应用 update 变更（todo 文本 / assignee / deadline / priority），迁移已读 key */
function applyTodoUpdate(data, todo, changes) {
  const src = todo && todo.source && typeof todo.source === 'object' ? todo.source : {}
  const oldKey = todoKey(todo)
  const next = Object.assign({}, todo || {})
  if (typeof changes.todo === 'string' && changes.todo.trim()) next.todo = changes.todo.trim()
  if (typeof changes.assignee === 'string') next.assignee = changes.assignee.trim()
  if (typeof changes.deadline === 'string') next.deadline = changes.deadline.trim()
  if (typeof changes.priority === 'string') next.priority = changes.priority.trim()
  const newKey = todoKey(next)
  const idx = (data.todos || []).findIndex((t) => todoKey(t) === oldKey)
  if (idx < 0) return null
  // 描述变化会导致 key 变化：迁移已读标记，避免已读状态丢失
  if (oldKey !== newKey && data.todoSeen && data.todoSeen[oldKey]) {
    if (!data.todoSeen[newKey]) data.todoSeen[newKey] = true
    delete data.todoSeen[oldKey]
  }
  data.todos[idx] = next
  return next
}

/**
 * 识别后已读保留（兜底）：LLM 每次提取的描述措辞可能漂移 → key 变化 → 旧已读标记匹配不上。
 * 对每个新待办：若旧 todoSeen 中有「同群 + 归一化文本互相包含」的已读记录，补标已读，
 * 避免「同步识别后已读变未读」。精确命中（含合并迁移后的）直接跳过。
 */
function migrateSeenBySimilarity(data, newTodos) {
  const seen = data.todoSeen && typeof data.todoSeen === 'object' ? data.todoSeen : {}
  if (!seen || typeof seen !== 'object') return
  const seenKeys = Object.keys(seen)
  if (!seenKeys.length || !Array.isArray(newTodos) || !newTodos.length) return
  let changed = false
  for (const t of newTodos) {
    const k = todoKey(t)
    if (seen[k]) continue // 已精确命中（或其合并来源迁移过）
    const sp = k.indexOf('::')
    if (sp < 0) continue
    const chatId = k.slice(0, sp)
    const norm = k.slice(sp + 2)
    if (!norm) continue
    const hit = seenKeys.some((sk) => {
      const s = sk.indexOf('::')
      if (s < 0) return false
      if (sk.slice(0, s) !== chatId) return false
      const sn = sk.slice(s + 2)
      if (!sn) return false
      return sn.includes(norm) || norm.includes(sn)
    })
    if (hit) { seen[k] = true; changed = true }
  }
  if (changed) saveData(DATA_PATH(), data)
}

async function doTodos(refreshFirst) {
  if (refreshFirst) await doSync()
  const cfg = fullConfig()
  const data = state.dataJson || emptyData()
  const followed = new Set((data.followedChats || []).map(String))
  const completed = data.completedTodos || {}

  const chats = (data.chats || []).filter((chat) => {
    if (!followed.has(String(chat.chat_id))) return false // 仅识别关注群
    const messages = (data.messages && data.messages[chat.chat_id]) || []
    return messages.length > 0
  })

  // 群级并行调用 LLM（受限），每个群内分片也并行；整体并发受束，避免打爆模型限流
  const chatConcurrency = Number(cfg.sync.todoConcurrency) || 2
  const chunkConcurrency = Number(cfg.sync.todoChunkConcurrency) || 2
  // 最新消息补充识别条数：全量分片识别对「片尾最新消息」易漏检（模型长上下文注意力衰减），
  // 对每群最新 N 条单独再识别一次（小批识别可靠），合并进结果
  const latestPromptCount = Math.min(20, Math.max(1, Number(cfg.sync.latestPromptCount) || 10))
  const results = new Array(chats.length)
  await mapLimit(chats, chatConcurrency, async (chat, i) => {
    const messages = (data.messages && data.messages[chat.chat_id]) || []
    const names = (data.memberNames && data.memberNames[chat.chat_id]) || {}
    const { todos } = await extractTodos(cfg, { chat, messages, names }, { chunkConcurrency })
    const extra = []
    if (messages.length > latestPromptCount) {
      const tail = messages.slice(-latestPromptCount)
      try {
        const r2 = await extractTodos(cfg, { chat, messages: tail, names }, { chunkConcurrency: 1 })
        extra.push(...(Array.isArray(r2.todos) ? r2.todos : []))
      } catch { /* 补充识别失败不影响主结果 */ }
    }
    results[i] = todos.concat(extra)
  })

  const all = []
  const seenKeys = new Set()
  for (const arr of results) {
    if (!Array.isArray(arr)) continue
    for (const t of arr) {
      const k = todoKey(t)
      if (completed[k] || seenKeys.has(k)) continue // 已归档 / 本批已出现过的 key 不重复出现
      seenKeys.add(k)
      all.push(t)
    }
  }

  // AI 语义级去重：与已归档待办对比（措辞不同但同一件事 → 不再出现）
  let finalTodos = all
  try {
    const archivedForDedup = Object.keys(completed).map((k) => {
      const rec = completed[k]
      const obj = rec && typeof rec === 'object' ? rec : {}
      return { key: k, todo: String(obj.todo || ''), doneAt: typeof rec === 'number' ? rec : Number(obj.doneAt) || 0 }
    })
    finalTodos = await dedupTodosVsArchive(cfg, all, archivedForDedup)
  } catch {
    finalTodos = all // 去重失败不影响识别结果
  }

  // 聚合总结：把同一件事的琐碎小待办合并成一条概括性待办（设置 sync.mergeTodos 可关）
  const preMerge = finalTodos // mergedFrom 编号对应此数组
  let mergedCount = 0
  try {
    const merged = await mergeTodosSummary(cfg, preMerge)
    if (merged && Array.isArray(merged.todos) && merged.todos.length) {
      finalTodos = merged.todos
      mergedCount = merged.mergedCount || 0
    }
  } catch {
    mergedCount = 0 // 合并失败 → 保持原样
  }

  // 未读迁移：合并结果的任一来源已读 → 合并结果保持已读；新合并条目（来源均未读）保持未读
  if (mergedCount > 0 && finalTodos.length) {
    if (!data.todoSeen || typeof data.todoSeen !== 'object') data.todoSeen = {}
    for (const t of finalTodos) {
      const from = Array.isArray(t.mergedFrom) ? t.mergedFrom : []
      if (!from.length) continue
      const sources = from
        .map((n) => { const i = Number(n) - 1; return preMerge[i] || null })
        .filter(Boolean)
      if (sources.some((s) => data.todoSeen[todoKey(s)])) data.todoSeen[todoKey(t)] = true
    }
    saveData(DATA_PATH(), data)
    state.dataJson = data
  }

  data.todos = finalTodos
  // 已读保留兜底：同群 + 归一化包含匹配，避免措辞漂移导致「识别后已读变未读」
  migrateSeenBySimilarity(data, finalTodos)
  data.todosGeneratedAt = Date.now()
  saveData(DATA_PATH(), data)
  state.dataJson = data
  return finalTodos
}

// ---------------------------------------------------------------------------
// 定时调度：按配置周期自动「同步并识别」，识别出新增待办时写入提醒标记（lastNotify）
// ---------------------------------------------------------------------------

let scheduleTimer = null

function stopScheduler() {
  if (scheduleTimer) {
    clearInterval(scheduleTimer)
    scheduleTimer = null
  }
}

/** 定时跑一轮 同步+识别；开启提醒且识别出新增待办时写 lastNotify 标记（前端角标展示）。 */
async function runScheduledSyncRecognize(notify) {
  const before = new Set(((state.dataJson || {}).todos || []).map((t) => todoKey(t)))
  await doTodos(true) // 先（增量）同步，再识别
  const data = state.dataJson || emptyData()
  if (!data.todoSeen || typeof data.todoSeen !== 'object') data.todoSeen = {}
  const newTodos = (data.todos || []).filter((t) => !before.has(todoKey(t)))
  if (!notify && newTodos.length) {
    // 关闭「新增待办提醒」时：定时识别出的新待办直接标为已读，不产生未读提示
    newTodos.forEach((t) => { data.todoSeen[todoKey(t)] = true })
    saveData(DATA_PATH(), data)
    state.dataJson = data
  }
  // notify 开启（默认）时：新待办保持「未读」，消息栏逐条点掉后标已读
  return { newTodos: newTodos.length, followed: (data.followedChats || []).length }
}

/** 按最新配置重启定时器（插件启动 & 设置变更时调用）。 */
function restartScheduler() {
  stopScheduler()
  const cfg = fullConfig()
  const sched = (cfg && cfg.schedule) || {}
  if (!sched.enabled) return
  const intervalMs = Math.max(5, Number(sched.intervalMin) || 60) * 60 * 1000
  let running = false
  const tick = async () => {
    if (running) return // 上一轮还在跑则跳过
    running = true
    try {
      const cur = fullConfig()
      const au = (cur.auth && cur.auth.user) || {}
      const followed = ((state.dataJson || {}).followedChats || []).length
      if (!cur.auth.appId || !au.accessToken || !followed) return // 未授权或没关注群则跳过
      await runScheduledSyncRecognize((cur.schedule || {}).notify !== false)
    } catch (e) {
      try { console.warn('[feishu-todo] scheduled run failed:', e && e.message) } catch {}
    } finally {
      running = false
    }
  }
  scheduleTimer = setInterval(tick, intervalMs)
  if (scheduleTimer.unref) scheduleTimer.unref()
  try { console.log(`[feishu-todo] 定时调度已启用：每 ${intervalMs / 60000} 分钟自动同步识别`) } catch {}
}

// ---------------------------------------------------------------------------
// 状态汇总（浏览器半边展示）
// ---------------------------------------------------------------------------

function buildState() {
  const cfg = fullConfig()
  const user = (cfg.auth && cfg.auth.user) || {}
  const data = state.dataJson || emptyData()
  const now = Date.now()
  const msgs = data.messages || {}
  let msgCount = 0
  for (const k of Object.keys(msgs)) {
    if (Array.isArray(msgs[k])) msgCount += msgs[k].length
  }
  const followedSet = new Set((data.followedChats || []).map(String))
  // 归档（已完成）列表：按完成时间倒序，供浏览器端按时间筛选展示
  const completedEntries = Object.keys(data.completedTodos || {}).map((key) => {
    const rec = data.completedTodos[key]
    const obj = rec && typeof rec === 'object' ? rec : {}
    const doneAt = typeof rec === 'number' ? rec : Number(obj.doneAt) || 0
    const src = obj.source && typeof obj.source === 'object' ? obj.source : {}
    return {
      key,
      todo: String(obj.todo || '') || String(key.split('::')[1] || ''),
      chat: String(obj.chat || src.chat || ''),
      source: src,
      assignee: String(obj.assignee || ''),
      priority: String(obj.priority || ''),
      deadline: String(obj.deadline || ''),
      doneAt,
    }
  }).sort((a, b) => b.doneAt - a.doneAt)
  // 未读待办：todos 里 key 尚未标记「已读」的条目（消息栏逐条点掉后写 todoSeen）
  const todoSeenMap = data.todoSeen && typeof data.todoSeen === 'object' ? data.todoSeen : {}
  const todosOut = (data.todos || []).map((t) => {
    // 时间降级：有原始时间戳则按统一格式重算（旧数据只有 HH:mm 的 time 字符串也保持）
    const src = (t && t.source && typeof t.source === 'object') ? t.source : {}
    let out = t
    if (src.ts && !src.time) {
      out = { ...t, source: { ...src, time: formatClock(src.ts) } }
    } else if (src.ts && typeof src.time === 'string' && /^\d{1,2}:\d{2}$/.test(src.time)) {
      out = { ...t, source: { ...src, time: formatClock(src.ts) } }
    }
    return { ...out, key: todoKey(t), seen: Boolean(todoSeenMap[todoKey(t)]) }
  })
  const unreadTodos = todosOut.filter((t) => !t.seen)
  const unreadChats = [...new Set(unreadTodos.map((t) => (t.source && t.source.chat) || '').filter(Boolean))].slice(0, 5)
  return {
    auth: {
      appConfigured: Boolean(cfg.auth.appId && cfg.auth.appSecret),
      appIdMasked: maskSecret(cfg.auth.appId),
      userConfigured: Boolean(user.accessToken),
      userName: user.name || '',
      userOpenId: user.openId || '',
      tokenExpiresAt: user.expiresAt || 0,
      tokenValid: Boolean(user.expiresAt && user.expiresAt > now),
      tokenValidMs: Math.max(0, (user.expiresAt || 0) - now),
      hasRefreshToken: Boolean(user.refreshToken),
    },
    llm: {
      baseUrl: cfg.llm.baseUrl || '',
      model: cfg.llm.model || '',
      hasApiKey: Boolean(cfg.llm.apiKey),
    },
    sync: { days: Number(cfg.sync.days) || 7 },
    data: {
      fetchedAt: data.fetchedAt || 0,
      chatsCount: (data.chats || []).length,
      messagesCount: msgCount,
      todosCount: (data.todos || []).length,
      todosGeneratedAt: data.todosGeneratedAt || 0,
      followedChats: (data.followedChats || []).map(String),
      completedCount: completedEntries.length,
      completed: completedEntries,
      lastNotify: data.lastNotify || null,
      todoSeen: { ...todoSeenMap },
      unreadCount: unreadTodos.length,
      unreadChats,
      chats: (data.chats || []).map((c) => ({
        chat_id: c.chat_id,
        name: c.name || c.chat_id,
        count: Array.isArray(msgs[c.chat_id]) ? msgs[c.chat_id].length : 0,
        followed: followedSet.has(String(c.chat_id)),
      })),
      todos: todosOut,
    },
  }
}

// ---------------------------------------------------------------------------
// 路由处理器
// ---------------------------------------------------------------------------

function guard(fn) {
  return async (req, res) => {
    try {
      await fn(req, res)
    } catch (e) {
      writeJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }
}

const handlers = {
  state: guard(async (req, res) => {
    writeJson(res, 200, { ok: true, state: buildState() })
  }),
  sync: guard(async (req, res) => {
    const summary = await doSync()
    writeJson(res, 200, { ok: true, summary, state: buildState() })
  }),
  todos: guard(async (req, res) => {
    const body = await readJsonBody(req)
    const todos = await doTodos(Boolean(body && body.refresh))
    writeJson(res, 200, { ok: true, todos, state: buildState() })
  }),
  follow: guard(async (req, res) => {
    const body = await readJsonBody(req)
    const chatId = body && body.chatId
    const followed = Boolean(body && body.followed)
    if (!chatId) {
      writeJson(res, 400, { ok: false, error: '缺少 chatId' })
      return
    }
    const list = await setFollow(chatId, followed)
    writeJson(res, 200, { ok: true, followedChats: list, state: buildState() })
  }),
  todoDone: guard(async (req, res) => {
    const body = await readJsonBody(req)
    const key = body && body.key
    if (!key) {
      writeJson(res, 400, { ok: false, error: '缺少 key' })
      return
    }
    const todos = await markTodoDone(key, body || {})
    writeJson(res, 200, { ok: true, todos, state: buildState() })
  }),
  notifyAck: guard(async (req, res) => {
    // 兼容旧版提醒标记（前端已改用 todoSeen）：清除 lastNotify
    const data = state.dataJson || emptyData()
    if (data.lastNotify) {
      data.lastNotify = null
      saveData(DATA_PATH(), data)
      state.dataJson = data
    }
    writeJson(res, 200, { ok: true, state: buildState() })
  }),
  todoSeen: guard(async (req, res) => {
    // 逐条标记已读：消息栏未读数减一
    const body = await readJsonBody(req)
    const key = String((body && body.key) || '')
    const data = state.dataJson || emptyData()
    if (key) {
      if (!data.todoSeen || typeof data.todoSeen !== 'object') data.todoSeen = {}
      data.todoSeen[key] = true
      saveData(DATA_PATH(), data)
      state.dataJson = data
    }
    writeJson(res, 200, { ok: true, state: buildState() })
  }),
  todoSeenAll: guard(async (req, res) => {
    // 全部已读：当前所有待办一次标记
    const data = state.dataJson || emptyData()
    if (!data.todoSeen || typeof data.todoSeen !== 'object') data.todoSeen = {}
    for (const t of data.todos || []) data.todoSeen[todoKey(t)] = true
    saveData(DATA_PATH(), data)
    state.dataJson = data
    writeJson(res, 200, { ok: true, state: buildState() })
  }),
  todoRestore: guard(async (req, res) => {
    // 把已完成的待办撤回到待办列表（重新未读，可再次处理）
    const body = await readJsonBody(req)
    const key = String((body && body.key) || '')
    const data = state.dataJson || emptyData()
    const completed = data.completedTodos || {}
    const rec = completed[key]
    if (rec) {
      delete completed[key]
      const obj = rec && typeof rec === 'object' ? rec : {}
      const src = obj.source && typeof obj.source === 'object' ? obj.source : {}
      const item = {
        todo: String(obj.todo || '') || String(key.split('::')[1] || ''),
        assignee: String(obj.assignee || ''),
        priority: String(obj.priority || ''),
        deadline: String(obj.deadline || ''),
        source: src,
      }
      const exist = (data.todos || []).some((t) => todoKey(t) === key)
      if (!exist) (data.todos = data.todos || []).push(item)
      // 撤回的待办视为未读（需要重新处理）
      if (!data.todoSeen || typeof data.todoSeen !== 'object') data.todoSeen = {}
      delete data.todoSeen[key]
      saveData(DATA_PATH(), data)
      state.dataJson = data
    }
    writeJson(res, 200, { ok: true, state: buildState() })
  }),
  todoAsk: guard(async (req, res) => {
    // AI 待办助手（多轮 + 可执行）：解析意图 → answer / complete（勾选完成）/ update（修改描述与字段）
    const body = await readJsonBody(req)
    const question = String((body && body.question) || '').trim()
    if (!question) {
      writeJson(res, 400, { ok: false, error: '缺少问题' })
      return
    }
    const history = Array.isArray(body && body.history) ? body.history : []
    const cfg = fullConfig()
    const data = state.dataJson || emptyData()
    const todos = Array.isArray(data.todos) ? data.todos : []
    const applied = { completed: [], updated: [] }

    let answer = ''
    try {
      if (todos.length === 0) {
        answer = '当前没有可用的待办数据。请先在面板「待办」页同步并识别，或检查数据文件。'
      } else {
        let plan = null
        try { plan = await planTodosAction(cfg, todos, question, { history }) } catch (e) { plan = null }
        if (!plan || !plan.action) {
          // 降级：纯问答
          answer = await askTodos(cfg, todos, question, { history })
        } else {
          const action = plan.action === 'complete' ? 'complete' : plan.action === 'update' ? 'update' : 'answer'
          if (action === 'answer') {
            answer = String(plan.answerText || '').trim()
            if (!answer) answer = await askTodos(cfg, todos, question, { history })
          } else {
            const refs = Array.isArray(plan.todoRefs) ? plan.todoRefs.slice(0, 5) : []
            const changes = (Array.isArray(plan.changes) && plan.changes[0] && typeof plan.changes[0] === 'object') ? plan.changes[0] : {}
            if (!refs.length) {
              answer = '你想操作哪条待办呢？请说一下是「第几条」或待办原文（例如：把第 3 条改为已办）。'
            } else {
              if (action === 'complete') {
                for (const ref of refs) {
                  const hit = findTodoByRef(todos, ref)
                  if (!hit || hit.multiple) { answer += (answer ? '\n' : '') + `未找到待办「${ref}」` + (hit && hit.multiple ? '（匹配到多条，请更具体）' : '。'); continue }
                  const t = hit.todo
                  await markTodoDone(todoKey(t), { todo: t.todo, assignee: t.assignee || '', priority: t.priority || '', deadline: t.deadline || '', source: (t.source && typeof t.source === 'object') ? t.source : {} })
                  applied.completed.push(String(t.todo || ''))
                }
                if (applied.completed.length) answer = `已为你完成 ${applied.completed.length} 条待办：\n` + applied.completed.map((x) => '✅ ' + x).join('\n')
                else answer = '没有待办被标记为完成（请确认待办编号或原文）。'
              } else if (action === 'update') {
                const ref = refs[0]
                const hit = findTodoByRef(todos, ref)
                if (!hit || hit.multiple) {
                  answer = `未找到待办「${ref}」` + (hit && hit.multiple ? '（匹配到多条，请更具体）' : '。')
                } else {
                  const updated = applyTodoUpdate(data, hit.todo, changes)
                  if (updated) {
                    saveData(DATA_PATH(), data)
                    state.dataJson = data
                    answer = `已更新待办：\n「${hit.todo.todo}」${updated.todo !== hit.todo.todo ? '→ 「' + updated.todo + '」' : ''}` +
                      (updated.assignee !== (hit.todo.assignee || '') ? `\n负责人: ${updated.assignee || '(清除)'}` : '') +
                      (updated.deadline !== (hit.todo.deadline || '') ? `\n截止: ${updated.deadline || '(清除)'}` : '') +
                      (updated.priority !== (hit.todo.priority || '') ? `\n优先级: ${updated.priority || '(清除)'}` : '')
                    applied.updated.push({ before: String(hit.todo.todo || ''), after: String(updated.todo || '') })
                  } else {
                    answer = '更新失败：没有找到该待办。'
                  }
                }
              }
              if (plan.note) answer += '\n（' + String(plan.note) + '）'
            }
          }
        }
      }
    } catch (e) {
      writeJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
      return
    }

    writeJson(res, 200, { ok: true, answer: String(answer || ''), applied, state: buildState() })
  }),
  todoContext: guard(async (req, res) => {
    // 待办关联聊天上下文：定位触发该待办的消息，返回其前后各 N 条
    const body = await readJsonBody(req)
    const key = String((body && body.key) || '')
    const data = state.dataJson || emptyData()
    const todo = (data.todos || []).find((t) => todoKey(t) === key)
    if (!todo) {
      writeJson(res, 404, { ok: false, error: '未找到该待办' })
      return
    }
    const src = (todo.source && typeof todo.source === 'object') ? todo.source : {}
    const chatId = String(src.chatId || '')
    const msgs = (data.messages && data.messages[chatId]) || []
    const names = (data.memberNames && data.memberNames[chatId]) || {}
    if (!msgs.length) {
      writeJson(res, 200, { ok: true, chat: src.chat || '', context: [] })
      return
    }
    let idx = -1
    if (src.messageId) idx = msgs.findIndex((m) => m && m.message_id === src.messageId)
    if (idx < 0) {
      const ts = Number(src.ts) || 0
      if (ts) idx = msgs.findIndex((m) => Number(m && m.create_time) >= ts)
      if (idx < 0) idx = msgs.length - 1
    }
    const pad = 4
    const from = Math.max(0, idx - pad)
    const to = Math.min(msgs.length, idx + pad + 1)
    const context = []
    for (let i = from; i < to; i++) {
      const m = msgs[i]
      context.push({
        time: formatClock(Number(m && m.create_time)),
        sender: senderDisplayName(m, names),
        text: extractMessageText(m),
        msgType: (m && m.msg_type) || '',
        isHit: i === idx,
      })
    }
    writeJson(res, 200, { ok: true, chat: src.chat || '', key, context })
  }),
  chatsSearch: guard(async (req, res) => {
    const body = await readJsonBody(req)
    const query = String((body && body.query) || '').trim()
    if (!query) {
      writeJson(res, 200, { ok: true, chats: [] })
      return
    }
    const data = state.dataJson || emptyData()
    const followed = new Set((data.followedChats || []).map(String))
    let items = []
    try {
      const r = await makeClient(fullConfig()).searchChats(query, { pageSize: 50 })
      items = r.items || []
    } catch (e) {
      // 搜索接口失败时降级：本地缓存模糊匹配
      const q = query.toLowerCase()
      items = (data.chats || []).filter((c) => String(c.name || c.chat_id || '').toLowerCase().indexOf(q) !== -1)
    }
    const chats = items.map((c) => ({
      chat_id: c.chat_id,
      name: c.name || c.chat_id,
      followed: followed.has(String(c.chat_id)),
    }))
    writeJson(res, 200, { ok: true, chats })
  }),
  authStart: guard(async (req, res) => {
    const r = await startOauth()
    writeJson(res, 200, { ok: true, authorizeUrl: r.authorizeUrl, port: r.port })
  }),
  authStatus: guard(async (req, res) => {
    const cfg = fullConfig()
    const user = (cfg.auth && cfg.auth.user) || {}
    writeJson(res, 200, {
      ok: true,
      running: oauth ? (oauth.status === 'waiting' || oauth.status === 'authorized') : false,
      status: oauth ? oauth.status : 'idle',
      error: oauth ? oauth.error : null,
      hasUserToken: Boolean(user.accessToken),
      userName: user.name || '',
      userOpenId: user.openId || '',
    })
  }),
  authCancel: guard(async (req, res) => {
    if (oauth) {
      try { oauth.server.close() } catch (e) {}
      oauth = null
    }
    writeJson(res, 200, { ok: true })
  }),
  authRefresh: guard(async (req, res) => {
    const cfg = fullConfig()
    const user = (cfg.auth && cfg.auth.user) || {}
    if (!user.refreshToken) {
      writeJson(res, 400, { ok: false, error: '没有可用的 refresh_token，请重新个人授权。' })
      return
    }
    const client = makeClient(cfg)
    const tok = await client.refreshUserToken(user.refreshToken)
    const now = Date.now()
    await persistAuthUser({
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || user.refreshToken || '',
      expiresAt: now + (tok.expires_in || 7200) * 1000,
      refreshExpiresAt: tok.refresh_token_expires_in ? now + tok.refresh_token_expires_in * 1000 : (user.refreshExpiresAt || 0),
      openId: user.openId || '',
      name: user.name || '',
      avatarUrl: user.avatarUrl || '',
      scope: user.scope || '',
    })
    writeJson(res, 200, { ok: true })
  }),
  authRevoke: guard(async (req, res) => {
    await persistAuthUser({
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      refreshExpiresAt: 0,
      openId: '',
      name: '',
      avatarUrl: '',
      scope: '',
    })
    writeJson(res, 200, { ok: true })
  }),
}

const ROUTES = [
  { kind: 'exact', path: '/api/feishu-todo/state', handler: handlers.state },
  { kind: 'exact', path: '/api/feishu-todo/sync', handler: handlers.sync },
  { kind: 'exact', path: '/api/feishu-todo/todos', handler: handlers.todos },
  { kind: 'exact', path: '/api/feishu-todo/follow', handler: handlers.follow },
  { kind: 'exact', path: '/api/feishu-todo/todo-done', handler: handlers.todoDone },
  { kind: 'exact', path: '/api/feishu-todo/notify-ack', handler: handlers.notifyAck },
  { kind: 'exact', path: '/api/feishu-todo/todo-seen', handler: handlers.todoSeen },
  { kind: 'exact', path: '/api/feishu-todo/todo-seen-all', handler: handlers.todoSeenAll },
  { kind: 'exact', path: '/api/feishu-todo/todo-restore', handler: handlers.todoRestore },
  { kind: 'exact', path: '/api/feishu-todo/todo-ask', handler: handlers.todoAsk },
  { kind: 'exact', path: '/api/feishu-todo/todo-context', handler: handlers.todoContext },
  { kind: 'exact', path: '/api/feishu-todo/chats/search', handler: handlers.chatsSearch },
  { kind: 'exact', path: '/api/feishu-todo/auth/start', handler: handlers.authStart },
  { kind: 'exact', path: '/api/feishu-todo/auth/status', handler: handlers.authStatus },
  { kind: 'exact', path: '/api/feishu-todo/auth/cancel', handler: handlers.authCancel },
  { kind: 'exact', path: '/api/feishu-todo/auth/refresh', handler: handlers.authRefresh },
  { kind: 'exact', path: '/api/feishu-todo/auth/revoke', handler: handlers.authRevoke },
]

/** 模型可见公告（帮助 agent 知晓本插件存在，纯 GUI 插件无 agent 工具）。 */
export const FEISHU_TODO_GUIDANCE = '本机已安装 dsh-feishu-todo 插件（DSH 飞书待办）：侧边栏「飞书待办」入口；可配置飞书应用或完成个人授权，读取近 7 天群聊消息，用外部 OpenAI 兼容 LLM 识别待办，在面板中查看。配置在「设置 → 插件 → 飞书待办」。用户提到「飞书待办 / 读取飞书消息 / 识别待办」时即指本插件。'

/**
 * 挂载引擎、路由、设置节。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config schema 解析后的插件配置（默认值由 loader 应用）
 */
export function apply(ctx, config) {
  settingsCtx = ctx

  // 消息 / 待办缓存（仅缓存拉取结果，非配置）
  try {
    state.dataJson = loadData(DATA_PATH())
    // 升级兼容：旧数据没有 todoSeen 时，把已有待办视为已读（用户此前已看过列表），
    // 避免升级后全部变成未读产生噪音；新一次识别出的待办才会是未读。
    if (!state.dataJson.todoSeen || typeof state.dataJson.todoSeen !== 'object') {
      state.dataJson.todoSeen = {}
      for (const t of state.dataJson.todos || []) state.dataJson.todoSeen[todoKey(t)] = true
    }
  } catch {
    state.dataJson = emptyData()
  }

  // 可编辑配置：设置服务为唯一来源
  configSource = () => config ?? {}
  installSettingsSection(ctx, FEISHU_TODO_SETTINGS_NS, Config, config ?? {}, {
    setSource: (source) => {
      configSource = source
    },
    onChange: () => {
      // 配置实时读取；调度字段变更时按新配置重启定时器
      restartScheduler()
    },
  })

  // 个人授权 token 状态：设置服务为唯一来源（不在表单里编辑）
  authSource = () => ({})
  installSettingsSection(ctx, FEISHU_TODO_AUTH_NS, AuthState, {}, {
    setSource: (source) => {
      authSource = source
    },
    onChange: () => {
      // token 由 authSource() 实时读取，无需额外动作
    },
  })

  // 一次性迁移：旧版 ~/.dsh/feishu-todo.json → 设置服务
  ctx.effect(() => {
    ;(async () => {
      try {
        // 等两个命名空间注册完成（installSettingsSection 经 ctx.inject 注册，通常同步，
        // 这里给异步注册留最多 5s 的兜底重试）。
        for (let i = 0; i < 50; i++) {
          const s = ctx.get('settings', false)
          if (s && s.get && s.get(FEISHU_TODO_SETTINGS_NS) !== undefined && s.get(FEISHU_TODO_AUTH_NS) !== undefined) {
            await migrateLegacyConfig()
            return
          }
          await delay(100)
        }
        try { console.warn('[feishu-todo] settings namespaces not ready, legacy config not migrated') } catch {}
      } catch (e) {
        try { console.warn('[feishu-todo] migrate legacy config:', e && e.message) } catch {}
      }
    })()
  }, 'feishu-todo: migrate')

  // 路由生命周期（随 fiber 拆除）
  ctx.effect(
    () => {
      restartScheduler() // 首次按配置启动定时调度
      const disposers = ROUTES.map((route) => ctx.webServer.register(route))
      return () => {
        stopScheduler()
        for (const dispose of disposers) dispose()
        if (oauth) {
          try { oauth.server.close() } catch (e) {}
          oauth = null
        }
      }
    },
    'feishu-todo: routes',
  )
}