'use strict'

/**
 * 飞书开放平台 API 客户端（零依赖，Node >= 18 内置 fetch）。
 *
 * 覆盖：
 * - 自建应用 tenant_access_token（POST /auth/v3/tenant_access_token/internal）
 * - 个人授权 user_access_token 换取 / 刷新（POST /authen/v2/oauth/token）
 * - 用户信息（GET /authen/v1/user_info）
 * - 群列表（GET /im/v1/chats，仅群聊，不含单聊）
 * - 会话历史消息（GET /im/v1/messages，支持按时间范围分页拉取）
 */

import { sleep } from './util.js'
import { effectiveAuthMode } from './config.js'

const FEISHU_BASE = 'https://open.feishu.cn'
const OAUTH_AUTHORIZE_BASE = 'https://accounts.feishu.cn'

/** 常见错误码 -> 排查提示 */
const ERROR_HINTS = {
  230001: '请求参数错误，请检查输入参数（chat_id / 时间范围等）。',
  230002: '机器人不在对应群组中，需要先把应用机器人拉进目标群。',
  230006: '应用未启用机器人能力，请在开发者后台「应用能力」中添加机器人。',
  230013: '目标用户不在应用可用范围内（或已离职），请检查应用可用范围配置。',
  230027: '缺少权限：请检查应用是否已开通对应 API 权限并发布，或用户是否已完成授权。',
  231203: '群类型不支持获取消息（例如群开启保密模式禁止复制消息）。',
  231204: '开启了对外共享或关联组织的应用不支持以用户身份请求该接口。',
  232025: '应用未启用机器人能力，请在开发者后台添加机器人能力并发布。',
  232034: '应用在本租户下未安装或未启用。',
  99991661: '请求频率超限，请稍后重试（已自动重试过）。',
  99991663: '请求频率超限，请稍后重试（已自动重试过）。',
  99991679: 'user_access_token 缺少目标 API 所需权限，需要重新完成用户授权。',
  20001: '请求参数缺失，请检查请求。',
  20002: 'client_id / client_secret 校验失败，请检查应用凭证。',
  20003: '授权码无效（授权码只能使用一次）。',
  20004: '授权码已过期（授权码 5 分钟有效）。',
  20008: '用户不存在。',
  20009: '租户未安装该应用，请联系租户管理员安装。',
  20010: '用户没有该应用的使用权限。',
  20024: '授权码/refresh_token 与 client_id 不匹配，请勿混用不同应用的凭证。',
  20027: '授权链接 scope 中包含应用未开通的权限，请在开发者后台权限管理中开通。',
  20036: 'grant_type 不支持。',
  20037: 'refresh_token 已过期，需要用户重新授权。',
  20049: 'PKCE 校验失败，请检查 code_verifier。',
  20063: '请求体缺少必要字段。',
  20065: '授权码已被使用，授权码只能使用一次。',
  20067: 'scope 参数包含重复权限。',
  20068: 'scope 参数包含未授权权限。',
}

export function hintFor(code) {
  return ERROR_HINTS[code] || null
}

export class FeishuError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'FeishuError'
    this.code = opts.code
    this.httpStatus = opts.httpStatus
    this.logId = opts.logId
    this.url = opts.url
  }
}

export class FeishuClient {
  constructor(config, opts = {}) {
    this.config = config
    this.baseUrl = (config.auth && config.auth.baseUrl) || FEISHU_BASE
    this.tenantToken = null
    this.tenantExpireAt = 0 // 毫秒
    this.onUserTokenRefreshed = typeof opts.onUserTokenRefreshed === 'function' ? opts.onUserTokenRefreshed : null
  }

  /** 通用请求：自动 JSON、超时、重试 */
  async request(path, { method = 'GET', query, body, token, timeoutMs = 30000, retries = 3 } = {}) {
    let url = `${this.baseUrl}${path}`
    if (query) {
      const usp = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') usp.set(k, String(v))
      }
      const qs = usp.toString()
      if (qs) url += `?${qs}`
    }

    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (token) headers.Authorization = `Bearer ${token}`

    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200))
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeoutMs)
      let res
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        })
      } catch (err) {
        clearTimeout(timer)
        lastErr = err
        // 网络错误/超时：重试
        if (attempt < retries) continue
        throw new FeishuError(`网络请求失败: ${err.message}`, { url })
      }
      clearTimeout(timer)

      const text = await res.text().catch(() => '')
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = null
      }

      // HTTP 层失败
      if (!res.ok) {
        const code = json && json.code
        const retryable = res.status === 429 || res.status >= 500 || code === 99991661 || code === 99991663
        if (retryable && attempt < retries) {
          lastErr = new FeishuError(`HTTP ${res.status}: ${(json && json.msg) || text.slice(0, 200)}`, {
            code,
            httpStatus: res.status,
            url,
          })
          continue
        }
        const msg = json && json.msg ? json.msg : `HTTP ${res.status}`
        throw new FeishuError(msg, { code, httpStatus: res.status, logId: json && json.log_id, url })
      }

      // 业务错误码
      if (json && json.code !== undefined && json.code !== 0) {
        const retryable = json.code === 99991661 || json.code === 99991663 || json.code === 99991662
        if (retryable && attempt < retries) {
          lastErr = new FeishuError(String(json.msg), { code: json.code, logId: json.log_id, url })
          continue
        }
        throw new FeishuError(String(json.msg || `业务错误码 ${json.code}`), {
          code: json.code,
          logId: json.log_id,
          url,
        })
      }
      return json || {}
    }
    throw lastErr || new FeishuError('请求失败', { url })
  }

  /** 自建应用 tenant_access_token（缓存；剩余有效期 < 30 分钟时重新获取） */
  async getTenantToken() {
    const now = Date.now()
    if (this.tenantToken && this.tenantExpireAt - now > 30 * 60 * 1000) return this.tenantToken
    const { auth } = this.config
    const json = await this.request('/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: auth.appId, app_secret: auth.appSecret },
    })
    if (!json.tenant_access_token) {
      throw new FeishuError(`获取 tenant_access_token 失败: ${json.msg || '未知错误'}`, { code: json.code })
    }
    this.tenantToken = json.tenant_access_token
    this.tenantExpireAt = now + (json.expire || 7200) * 1000
    return this.tenantToken
  }

  /** 当前 user_access_token；过期且存在 refresh_token 时自动刷新 */
  async getUserToken() {
    const user = this.config.auth.user
    const now = Date.now()
    const needRefresh =
      !user.accessToken ||
      (user.expiresAt > 0 && user.expiresAt - now < 5 * 60 * 1000) ||
      (!user.expiresAt && user.refreshToken)
    if (needRefresh && user.refreshToken) {
      const refreshed = await this.refreshUserToken(user.refreshToken)
      const next = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || user.refreshToken,
        expiresAt: now + (refreshed.expires_in || 7200) * 1000,
        refreshExpiresAt: refreshed.refresh_token_expires_in ? now + refreshed.refresh_token_expires_in * 1000 : (user.refreshExpiresAt || 0),
        openId: user.openId,
        name: user.name,
        avatarUrl: user.avatarUrl,
        scope: user.scope,
      }
      this.config.auth.user = next
      if (this.onUserTokenRefreshed) {
        try { await this.onUserTokenRefreshed(next) } catch (e) {}
      }
      return next.accessToken
    }
    if (!user.accessToken) {
      throw new FeishuError('未配置个人授权（user_access_token），请先完成个人授权。', { code: 'NO_USER_TOKEN' })
    }
    return user.accessToken
  }

  /** 按生效模式取请求令牌 */
  async getAccessToken() {
    const mode = effectiveAuthMode(this.config)
    if (mode === 'user') return this.getUserToken()
    if (mode === 'app') return this.getTenantToken()
    throw new FeishuError('尚未配置任何授权方式：请先在设置页填写应用凭证（appId/appSecret）或完成个人授权。', {
      code: 'NO_AUTH',
    })
  }

  /** 获取用户或机器人所在群列表（分页，按最近活跃优先，避免缓存截断后的旧群） */
  async listChats({ pageSize = 100, pageToken } = {}) {
    const token = await this.getAccessToken()
    const json = await this.request('/open-apis/im/v1/chats', {
      query: { page_size: pageSize, page_token: pageToken, sort_type: 'ByActiveTimeDesc' },
      token,
    })
    const data = json.data || {}
    return { items: data.items || [], pageToken: data.page_token || '', hasMore: Boolean(data.has_more) }
  }

  /** 拉取全部群（分页 + 去重 + 上限） */
  async listAllChats(max = 200) {
    const chats = []
    let pageToken = ''
    let guard = 0
    do {
      const { items, pageToken: next, hasMore } = await this.listChats({ pageSize: 100, pageToken })
      for (const c of items) chats.push(c)
      pageToken = next
      guard++
      if (!hasMore || guard > 50) break
      await sleep(120)
    } while (chats.length < max)
    return chats.slice(0, max)
  }

  /**
   * 按名称搜索群（用户/机器人可见范围内的全部群，不受本地缓存上限影响）。
   * 对应飞书 im/v1/chats/search，支持部分名称模糊匹配。
   */
  async searchChats(query, { pageSize = 50, pageToken } = {}) {
    const token = await this.getAccessToken()
    const json = await this.request('/open-apis/im/v1/chats/search', {
      query: { query: query, page_size: pageSize, page_token: pageToken },
      token,
    })
    const data = json.data || {}
    return { items: data.items || [], pageToken: data.page_token || '', hasMore: Boolean(data.has_more) }
  }

  /**
   * 获取会话历史消息（单页）。
   * @param {string} chatId 群/单聊 chat_id
   * @param {{startSec:number,endSec:number,pageSize?:number,pageToken?:string}} opts
   */
  async listMessages(chatId, { startSec, endSec, pageSize = 50, pageToken } = {}) {
    const token = await this.getAccessToken()
    const json = await this.request('/open-apis/im/v1/messages', {
      query: {
        container_id_type: 'chat',
        container_id: chatId,
        start_time: startSec,
        end_time: endSec,
        sort_type: 'ByCreateTimeAsc',
        page_size: pageSize,
        page_token: pageToken,
      },
      token,
    })
    const data = json.data || {}
    return { items: data.items || [], pageToken: data.page_token || '', hasMore: Boolean(data.has_more) }
  }

  /** 拉取某会话在时间窗口内的全部消息（分页 + 节流 + 上限） */
  async getAllMessages(chatId, { startSec, endSec, max = 2000, onPage } = {}) {
    const out = []
    let pageToken = ''
    let guard = 0
    do {
      const { items, pageToken: next, hasMore } = await this.listMessages(chatId, {
        startSec,
        endSec,
        pageSize: 50,
        pageToken,
      })
      for (const m of items) out.push(m)
      pageToken = next
      if (typeof onPage === 'function') onPage(items.length, out.length, hasMore)
      guard++
      if (!hasMore || guard > 100) break
      await sleep(150) // 节流，避免触发 50 次/秒频控
    } while (out.length < max)
    return out.slice(0, max)
  }

  /** 获取群信息（名称等） */
  async getChat(chatId) {
    const token = await this.getAccessToken()
    const json = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, { token })
    return json.data || {}
  }

  /** 获取群成员列表（尽力而为：用于把 open_id 解析为姓名；失败不影响主流程） */
  async listChatMembers(chatId, { pageSize = 100, pageToken } = {}) {
    const token = await this.getAccessToken()
    const json = await this.request(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, {
      query: { page_size: pageSize, page_token: pageToken },
      token,
    })
    const data = json.data || {}
    return { items: data.items || [], pageToken: data.page_token || '', hasMore: Boolean(data.has_more) }
  }

  /** 拉取群成员 open_id -> 姓名 映射（分页 + 上限） */
  async fetchMemberNames(chatId, max = 1000) {
    const map = {}
    let pageToken = ''
    let guard = 0
    do {
      const { items, pageToken: next, hasMore } = await this.listChatMembers(chatId, { pageSize: 100, pageToken })
      for (const it of items) {
        if (it.member_id && it.name) map[it.member_id] = it.name
      }
      pageToken = next
      guard++
      if (!hasMore || guard > 20) break
      await sleep(100)
    } while (Object.keys(map).length < max)
    return map
  }

  /** 获取用户信息（需 user_access_token） */
  async getUserInfo(userToken) {
    const json = await this.request('/open-apis/authen/v1/user_info', { token: userToken })
    return json.data || {}
  }

  /** 用授权码换取 user_access_token */
  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const { auth } = this.config
    const body = {
      grant_type: 'authorization_code',
      client_id: auth.appId,
      client_secret: auth.appSecret,
      code,
      redirect_uri: redirectUri,
    }
    if (codeVerifier) body.code_verifier = codeVerifier
    const json = await this.request('/open-apis/authen/v2/oauth/token', { method: 'POST', body })
    if (!json.access_token) {
      throw new FeishuError(`换取 user_access_token 失败: ${json.error_description || json.error || json.msg || '未知错误'}`, {
        code: json.code,
      })
    }
    return json
  }

  /** 刷新 user_access_token（refresh_token 一次性，返回新的两者） */
  async refreshUserToken(refreshToken) {
    const { auth } = this.config
    const json = await this.request('/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      body: {
        grant_type: 'refresh_token',
        client_id: auth.appId,
        client_secret: auth.appSecret,
        refresh_token: refreshToken,
      },
    })
    if (!json.access_token) {
      throw new FeishuError(`刷新 user_access_token 失败: ${json.error_description || json.error || json.msg || '未知错误'}`, {
        code: json.code,
      })
    }
    return json
  }
}

/** 构造授权页 URL（v2 OAuth，scope 空格分隔） */
export function buildAuthorizeUrl(config, { redirectUri, scope, state, codeChallenge }) {
  const base = (config.auth && config.auth.authorizeBase) || OAUTH_AUTHORIZE_BASE
  const usp = new URLSearchParams()
  usp.set('client_id', config.auth.appId)
  usp.set('response_type', 'code')
  usp.set('redirect_uri', redirectUri)
  usp.set('scope', scope)
  usp.set('state', state)
  usp.set('prompt', 'consent')
  if (codeChallenge) {
    usp.set('code_challenge', codeChallenge)
    usp.set('code_challenge_method', 'S256')
  }
  return `${base}/open-apis/authen/v1/authorize?${usp.toString()}`
}

export { FEISHU_BASE, OAUTH_AUTHORIZE_BASE }