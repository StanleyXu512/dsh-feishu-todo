'use strict'

/**
 * OpenAI 兼容 Chat Completions 客户端（默认流式）。
 *
 * 流式模式适配「推理型」模型（deepseek-v4-* / r1 等）：这类模型会先长时间输出
 * thinking/reasoning，最后才给出最终答案。非流式调用要等服务端把「思考+回答」全部
 * 生成完才返回，真实任务往往几分钟毫无响应，触发固定超时后表现为「识别不出来」。
 * 流式下边接收边等待，超时策略改为：
 *   - idleTimeoutMs：一段时间没有任何数据（服务器静默）→ 判死并重试
 *   - maxTimeoutMs：整个请求（含思考）的总预算，防止无限思考
 *
 * 兼容任意 OpenAI 风格服务（OpenAI / DeepSeek / 通义 / Moonshot / 本地 vLLM 等），
 * 通过配置 llm.baseUrl / llm.apiKey / llm.model 切换；服务不支持流式或 json 模式时
 * 自动降级重试。
 */

import { sleep } from './util.js'

export class LLMError extends Error {
  constructor(message, opts = {}) {
    super(message)
    this.name = 'LLMError'
    this.httpStatus = opts.httpStatus
  }
}

/** 可重试的瞬时错误状态码（过载/限流/网关抖动） */
const RETRYABLE = new Set([429, 500, 502, 503, 504])
const MAX_RETRIES = 3

function backoffMs(attempt) {
  return Math.min(1500 * Math.pow(2, attempt), 12000)
}

/**
 * 调用 chat/completions（默认流式）。
 * @param {object} cfg llm 配置片段
 * @param {{system?:string, user?:string}} input
 * @param {{json?:boolean, onDelta?:(content:string, reasoningChars:number)=>void}} opts
 * @returns {Promise<string>} 最终回答文本
 */
export async function chatCompletion(cfg, input, { json = false, onDelta } = {}) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '')
  const url = `${base}/chat/completions`

  const messages = []
  if (input.system) messages.push({ role: 'system', content: input.system })
  messages.push({ role: 'user', content: input.user })

  const timeoutMs = Number(cfg.timeoutMs) || 120000
  const maxTimeoutMs = Math.max(timeoutMs, Number(cfg.maxTimeoutMs) || 480000)
  const idleTimeoutMs = Number(cfg.idleTimeoutMs) || 45000
  const maxTokens = Number(cfg.maxTokens) || 0
  const temperature = cfg.temperature !== undefined ? cfg.temperature : 0.2
  /** 是否走流式（个别服务不支持流式时可整体关闭） */
  const useStream = cfg.useStream !== false

  const doCall = async (withJson, attempt = 0, stream = useStream, jsonForThis = Boolean(withJson && cfg.jsonMode !== false), skipMaxTokens = false) => {
    const body = { model: cfg.model, messages, temperature }
    if (stream) body.stream = true
    if (jsonForThis) body.response_format = { type: 'json_object' }
    // 推理型模型思考可能耗尽输出预算，导致"只思考没答案"：显式给出较大 max_tokens（随重试次数翻倍）。
    // 个别服务拒绝该参数时（400 报 max_tokens 相关）会自动去掉重试。
    if (maxTokens > 0 && !skipMaxTokens) body.max_tokens = Math.min(maxTokens * Math.pow(2, attempt), 65536)
    const headers = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`

    const ctrl = new AbortController()
    let abortReason = '' // 'idle' | 'total' | ''
    const totalMs = stream ? maxTimeoutMs : timeoutMs
    const totalTimer = setTimeout(() => {
      abortReason = abortReason || 'total'
      ctrl.abort()
    }, totalMs)
    let idleTimer = null

    try {
      let res
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal })
      } catch (err) {
        // 网络层失败（含超时 abort / DNS / 连接重置）
        const isAbort = /abort/i.test(String(err && err.name)) || /aborted/i.test(String(err && err.message))
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt))
          return doCall(withJson, attempt + 1, stream, jsonForThis, skipMaxTokens)
        }
        throw new LLMError(describeFailure(abortReason, totalMs, idleTimeoutMs, isAbort, netDetail(err), { url, model: cfg.model }))
      }

      const text = stream ? null : await res.text().catch(() => '')
      let json = null
      if (!stream) {
        try { json = text ? JSON.parse(text) : null } catch { json = null }
      }

      if (!res.ok) {
        const errMsg = (json && (json.error && (json.error.message || json.error)) || json && json.message) || `HTTP ${res.status}`
        // 兼容服务不支持 response_format=json_object → 去掉 json 重试
        const jsonModeReject = jsonForThis && res.status === 400 && /response_format|json_object|json mode/i.test(String(errMsg))
        if (jsonModeReject) return doCall(withJson, attempt, stream, false, skipMaxTokens)
        // 兼容服务不支持 stream → 降级非流式重试
        const streamReject = stream && res.status === 400 && /stream/i.test(String(errMsg))
        if (streamReject) return doCall(withJson, attempt, false, jsonForThis, skipMaxTokens)
        // 兼容服务拒绝 max_tokens 参数 → 去掉后重试
        const maxTokensReject = !skipMaxTokens && res.status === 400 && /max[_\- ]?tokens?|maximum tokens/i.test(String(errMsg))
        if (maxTokensReject) return doCall(withJson, attempt, stream, jsonForThis, true)
        if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          let ra = NaN
          try { ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')) } catch { ra = NaN }
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 20000) : backoffMs(attempt)
          await sleep(wait)
          return doCall(withJson, attempt + 1, stream, jsonForThis, skipMaxTokens)
        }
        throw new LLMError(`LLM 接口错误 (${res.status}): ${errMsg}`, { httpStatus: res.status })
      }

      if (!stream) {
        const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
        if (typeof content !== 'string' || !content.trim()) {
          // 偶发空内容：如输出预算被推理耗尽 → 重试（随重试翻倍 max_tokens），仍空才报错
          if (attempt < MAX_RETRIES) {
            await sleep(backoffMs(attempt))
            return doCall(withJson, attempt + 1, stream, jsonForThis, skipMaxTokens)
          }
          throw new LLMError(`LLM 返回内容为空（重试 ${MAX_RETRIES} 次仍无结果）。请检查模型配置与额度。`)
        }
        return content
      }

      // ---------- 流式读取 ----------
      const contentType = String(res.headers.get('content-type') || '')
      if (!contentType.includes('text/event-stream')) {
        // 服务端忽略了 stream 参数、直接返回普通 JSON 完成响应
        const t = await res.text()
        let j = null
        try { j = t ? JSON.parse(t) : null } catch { j = null }
        const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
        if (typeof c === 'string' && c.trim()) return c
        throw new LLMError('LLM 返回内容为空（请检查模型配置与额度）。')
      }
      if (!res.body || !res.body.getReader) {
        const t = await res.text()
        if (!t.trim()) throw new LLMError('LLM 返回内容为空（请检查模型配置与额度）。')
        return t
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let content = ''
      let reasoningChars = 0
      let finishReason = null
      const touchIdle = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          abortReason = abortReason || 'idle'
          ctrl.abort()
        }, idleTimeoutMs)
      }
      touchIdle()
      try {
        while (!finishReason) {
          const { value, done } = await reader.read()
          if (done) break
          touchIdle()
          buf += decoder.decode(value, { stream: true })
          let nl
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') { finishReason = 'stop'; break }
            let j
            try { j = JSON.parse(payload) } catch { continue }
            const choice = j.choices && j.choices[0]
            if (!choice) continue
            const delta = choice.delta || {}
            if (typeof delta.reasoning_content === 'string') reasoningChars += delta.reasoning_content.length
            if (typeof delta.content === 'string' && delta.content) {
              content += delta.content
              if (typeof onDelta === 'function') onDelta(content, reasoningChars)
            }
            if (choice.finish_reason) finishReason = choice.finish_reason
          }
        }
        if (!content.trim()) {
          // 模型只输出思考、没吐答案：可能是输出预算被思考耗尽或偶发中断 → 重试（翻倍 max_tokens）
          if (attempt < MAX_RETRIES) {
            await sleep(backoffMs(attempt))
            return doCall(withJson, attempt + 1, stream, jsonForThis, skipMaxTokens)
          }
          const why =
            'LLM 返回内容为空（模型只输出了思考过程' +
            (reasoningChars ? '，思考约 ' + Math.round(reasoningChars / 1000) + 'k 字符' : '') +
            (finishReason ? '，finish_reason=' + finishReason : '') +
            `，重试 ${MAX_RETRIES} 次仍无结果）。请检查模型配置或更换模型。`
          throw new LLMError(why)
        }
        return content
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
      }
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer)
      // 业务错误（内容为空 / 接口错误）直接透传，不做重试
      if (err instanceof LLMError) throw err
      // 流式读取中断（空闲/总超时 abort、解析异常等）→ 重试
      const isAbort = err && (/abort/i.test(String(err.name)) || /aborted/i.test(String(err.message)))
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt))
        return doCall(withJson, attempt + 1, stream, jsonForThis, skipMaxTokens)
      }
      throw new LLMError(describeFailure(abortReason, totalMs, idleTimeoutMs, isAbort, netDetail(err), { url, model: cfg.model }))
    } finally {
      clearTimeout(totalTimer)
    }
  }

  return doCall(json)
}

function describeFailure(abortReason, totalMs, idleMs, isAbort, raw, opts = {}) {
  if (abortReason === 'idle') return `模型响应停滞（${Math.round(idleMs / 1000)}s 无输出后中断）`
  if (abortReason === 'total') return `LLM 请求超时（>${Math.round(totalMs / 1000)}s）`
  if (isAbort) return `LLM 请求超时（>${Math.round(totalMs / 1000)}s）`
  const where = opts.url ? `（服务 ${opts.url} · 模型 ${opts.model || '-'}）` : ''
  return `LLM 请求失败: ${raw}${where}`
}

/** 网络层错误细节：undici 的 "fetch failed" 真实原因在 cause 链里 */
function netDetail(err) {
  const base = String((err && err.message) || '网络错误')
  let e = err
  let cause = ''
  while (e) {
    const c = e.cause
    if (!c) break
    cause = String((c && c.message) || c)
    e = c instanceof Error ? c : null
  }
  return cause ? `${base}（${cause}）` : base
}