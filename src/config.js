'use strict'

/**
 * 配置加载 / 保存。
 *
 * 默认配置文件：~/.dsh/feishu-todo.json；默认数据文件：~/.dsh/feishu-todo-data.json。
 * 本模块现由宿主插件（ESM）导入，CLI 已移除。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_CONFIG_PATH = () => path.join(os.homedir(), '.dsh', 'feishu-todo.json')
export const DEFAULT_DATA_PATH = () => path.join(os.homedir(), '.dsh', 'feishu-todo-data.json')

export const DEFAULTS = {
  auth: {
    // auto: 优先 user（个人授权），其次 app（应用身份）
    mode: 'auto',
    appId: '',
    appSecret: '',
    // 个人授权回调地址；留空则用本地临时回调 http://127.0.0.1:<port>/oauth/callback
    redirectUri: '',
    // 是否启用 PKCE (S256)，飞书 v2 OAuth 推荐开启
    pkce: true,
    // 追加的授权 scope（空格分隔字符串），默认按需自动拼接
    extraScopes: '',
    user: {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0, // 毫秒时间戳
      refreshExpiresAt: 0, // 毫秒时间戳
      openId: '',
      name: '',
      avatarUrl: '',
    },
  },
  llm: {
    // OpenAI 兼容 Chat Completions
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    // 请求 response_format=json_object（部分兼容服务不支持，可关闭）
    jsonMode: true,
    temperature: 0.2,
    // 单次请求总超时；流式时模型思考可能远超此值，用 maxTimeoutMs 兜底
    timeoutMs: 120000,
    maxTimeoutMs: 480000,
    // 流式「空闲」超时：超过该时长没有任何数据则判死（默认 45s）
    idleTimeoutMs: 45000,
    // 显式输出 token 预算（含思考），防止推理型模型思考耗尽预算导致"只思考没答案"；
    // 设为 0 则不发送该参数；重试时自动翻倍，服务拒绝该参数时自动降级去掉。
    maxTokens: 8192,
  },
  sync: {
    // 拉取最近 N 天的消息
    days: 7,
    maxChats: 200,
    maxMessagesPerChat: 2000,
    // 尽力而为地把群成员 open_id 解析为姓名（需 im:chat.member:readonly 权限，失败自动降级）
    fetchMemberNames: true,
    // 额外纳入的 chat_id（例如单聊 p2p，需 im:message.p2p_msg:get_as_user 权限）
    chatIds: [],
    excludeChatIds: [],
    // 拉取消息时并行处理的群数（调大可提速，但更易触发飞书频控）
    concurrency: 4,
    // AI 识别待办时并行处理的群数 / 单群内分片并行数（整体 LLM 并发 = 两者之积）
    todoConcurrency: 2,
    todoChunkConcurrency: 2,
    // 增量同步时，拉取起点向前多重的重叠秒数，避免边界漏消息
    incrementalOverlapSec: 60,
    // 识别后与「已归档（已完成）」待办做 AI 语义级去重（措辞不同但同一件事不再重复出现）；
    // 设为 false 则只做精确文本匹配。语义去重失败会自动降级为精确匹配，不阻断识别。
    semanticDedup: true,
    // 提取完成后做 AI 聚合总结：把同一件事的琐碎小待办合并成一条概括性待办，减少条目数量；
    // 设为 false 则保持扁平明细列表。合并失败自动降级为原样返回，不阻断识别。
    mergeTodos: true,
  },
  schedule: {
    // 定时自动「同步并识别」；识别出新增待办时留提醒标记（lastNotify，面板角标展示）
    enabled: false,
    intervalMin: 60,
    notify: true,
  },
  store: {
    dataPath: '',
  },
}

export function defaultConfigPath() {
  return process.env.FEISHU_TODO_CONFIG || DEFAULT_CONFIG_PATH()
}

export function defaultDataPath() {
  return process.env.FEISHU_TODO_DATA || DEFAULT_DATA_PATH()
}

/** 递归合并：patch 的 undefined 字段忽略；数组整体替换 */
export function mergeConfig(base, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch === undefined ? base : patch
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeConfig(base[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

/** 读取配置文件（不存在则返回空对象） */
export function readConfigFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new Error(`读取配置文件失败 ${filePath}: ${err.message}`)
  }
}

/** 环境变量覆盖 */
export function envOverrides() {
  const o = {}
  const env = process.env
  if (env.FEISHU_APP_ID) o.auth = { ...(o.auth || {}), appId: env.FEISHU_APP_ID }
  if (env.FEISHU_APP_SECRET) o.auth = { ...(o.auth || {}), appSecret: env.FEISHU_APP_SECRET }
  if (env.FEISHU_USER_ACCESS_TOKEN) {
    o.auth = { ...(o.auth || {}), user: { ...(o.auth && o.auth.user), accessToken: env.FEISHU_USER_ACCESS_TOKEN } }
  }
  if (env.LLM_API_KEY) o.llm = { ...(o.llm || {}), apiKey: env.LLM_API_KEY }
  if (env.LLM_BASE_URL) o.llm = { ...(o.llm || {}), baseUrl: env.LLM_BASE_URL }
  if (env.LLM_MODEL) o.llm = { ...(o.llm || {}), model: env.LLM_MODEL }
  if (env.FEISHU_TODO_DAYS) o.sync = { ...(o.sync || {}), days: Number(env.FEISHU_TODO_DAYS) }
  if (env.FEISHU_TODO_CHAT_IDS) {
    o.sync = {
      ...(o.sync || {}),
      chatIds: env.FEISHU_TODO_CHAT_IDS.split(',').map((s) => s.trim()).filter(Boolean),
    }
  }
  return o
}

/**
 * 加载完整配置。
 * @returns {{ config: object, configPath: string, dataPath: string }}
 */
export function loadConfig(cliPath) {
  const configPath = cliPath || defaultConfigPath()
  const fileCfg = readConfigFile(configPath)
  let config = mergeConfig(structuredCloneSafe(DEFAULTS), fileCfg)
  config = mergeConfig(config, envOverrides())
  const dataPath = (config.store && config.store.dataPath) || defaultDataPath()
  return { config, configPath, dataPath }
}

/** JSON 安全的深拷贝（DEFAULTS 为纯 JSON 对象） */
export function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/** 保存配置（写入临时文件后原子替换，权限 0600） */
export function saveConfig(config, configPath) {
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${configPath}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configPath)
  try {
    fs.chmodSync(configPath, 0o600)
  } catch {
    /* 平台差异可忽略 */
  }
}

/** 判断当前生效的授权模式：'user' | 'app' | null */
export function effectiveAuthMode(config) {
  const mode = config.auth && config.auth.mode
  const hasUser = Boolean(config.auth && config.auth.user && config.auth.user.accessToken)
  const hasApp = Boolean(config.auth && config.auth.appId && config.auth.appSecret)
  if (mode === 'user') return hasUser ? 'user' : null
  if (mode === 'app') return hasApp ? 'app' : null
  // auto
  if (hasUser) return 'user'
  if (hasApp) return 'app'
  return null
}

/** 当前需要的最小授权 scope（用户身份读取群聊消息） */
export const REQUIRED_SCOPES = [
  'im:message:readonly', // 获取单聊、群组消息
  'im:message.group_msg:get_as_user', // 以用户身份获取群聊消息
  'im:message.p2p_msg:get_as_user', // 以用户身份获取单聊消息（额外指定单聊时）
  'im:chat:readonly', // 获取群组信息（枚举群列表）
  'offline_access', // 刷新 token
]

/** 拼接授权链接用 scope（空格分隔） */
export function buildScopeString(config) {
  const extra = (config.auth && config.auth.extraScopes) || ''
  const set = new Set([...REQUIRED_SCOPES, ...extra.split(/\s+/).filter(Boolean)])
  return [...set].join(' ')
}